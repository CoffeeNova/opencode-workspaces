import { Database } from "bun:sqlite"
import { JournalError, JournalSchema, emptyJournal, type Journal, type JournalStore } from "./binding-journal.ts"

// A separate disposable SQLite file is only a crash-durable fixture for the
// protocol experiment. This does NOT replace/migrate the production JSON store
// and never opens OpenCode's database or a user registry.
export function journalStore(file: string): JournalStore & { close(): void } {
  const database = new Database(file, { create: true, strict: true })
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000")
    database.exec("CREATE TABLE IF NOT EXISTS probe_catalog (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)")
    const get = database.query<{ body: string }, []>("SELECT body FROM probe_catalog WHERE id = 1")
    const put = database.query("INSERT INTO probe_catalog (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
    function read(): Journal {
      const row = get.get()
      if (!row || Buffer.byteLength(row.body, "utf8") > 4 * 1024 * 1024) throw new JournalError("INVALID_JOURNAL", "Missing or oversized probe journal")
      try { return JournalSchema.parse(JSON.parse(row.body)) } catch {
        throw new JournalError("INVALID_JOURNAL", "Malformed, inconsistent, or unsupported probe journal; data was not overwritten")
      }
    }
    database.transaction(() => { if (!get.get()) put.run(JSON.stringify(emptyJournal())); read() }).immediate()
    return {
      read,
      transact<T>(update: (state: Journal) => T): T {
        return database.transaction(() => {
          const state = read()
          const before = structuredClone(state)
          const result = update(state)
          const validated = JournalSchema.safeParse(state)
          if (!validated.success) throw new JournalError("INVALID_JOURNAL", "The probe transition would violate its journal invariants")
          if (validated.data.catalogID !== before.catalogID) throw new JournalError("INVALID_JOURNAL", "A catalog identity cannot change")
          for (const [token, record] of Object.entries(before.tokens)) {
            if (JSON.stringify(validated.data.tokens[token]) !== JSON.stringify(record)) throw new JournalError("INVALID_JOURNAL", "Issued tokens are immutable and cannot be pruned")
          }
          for (const [id, record] of Object.entries(before.operations)) {
            const next = validated.data.operations[id]
            const allowed = record.phase === "prepared" ? ["prepared", "publishing", "aborted"]
              : record.phase === "publishing" ? ["publishing", "committed", "aborted"] : [record.phase]
            if (!next || !allowed.includes(next.phase) || JSON.stringify({ ...next, phase: record.phase }) !== JSON.stringify(record)) throw new JournalError("INVALID_JOURNAL", "Probe operation intent or terminal state cannot change")
          }
          const changed = JSON.stringify(validated.data) !== JSON.stringify(before)
          if (changed && validated.data.revision !== before.revision + 1) throw new JournalError("INVALID_JOURNAL", "A probe transition must advance its revision exactly once")
          const body = JSON.stringify(validated.data)
          if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new JournalError("JOURNAL_FULL", "Probe journal exceeds 4 MiB; no live records were pruned")
          put.run(body)
          return result
        }).immediate()
      },
      close: () => database.close(),
    }
  } catch (error) {
    database.close()
    throw error
  }
}
