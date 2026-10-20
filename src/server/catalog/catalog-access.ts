import { WorkspaceError } from "../../shared/errors.ts"
import { Catalog } from "./catalog.ts"

// Lazily opens the catalog: a read-only connection for discovery, a writable one
// on demand. Concurrent callers share one in-flight open; unload closes both.
export class CatalogAccess {
  private location: Promise<string> | undefined
  private writable: Catalog | undefined
  private readable: Catalog | undefined
  private reading: Promise<Catalog | undefined> | undefined
  private writing: Promise<Catalog> | undefined
  private disposed = false

  constructor(
    private readonly configuredPath: string | undefined,
    private readonly directory: string,
  ) {}

  async reader(): Promise<Catalog | undefined> {
    if (this.writable) return this.writable
    if (this.writing) return this.writing
    if (this.readable) return this.readable
    this.reading ??= this.catalogLocation()
      .then((file) => Catalog.existing(file, this.directory))
      .then((value) => {
        this.assertLive(value)
        this.readable = value
        return value
      })
      .finally(() => {
        this.reading = undefined
      })
    return this.reading
  }

  async writer(create: boolean): Promise<Catalog> {
    if (this.writable) return this.writable
    this.writing ??= this.catalogLocation()
      .then((file) => Catalog.open(file, this.directory, create))
      .then((value) => {
        this.assertLive(value)
        this.writable = value
        return value
      })
      .finally(() => {
        this.writing = undefined
      })
    return this.writing
  }

  dispose(): void {
    this.disposed = true
    this.writable?.close()
    this.readable?.close()
  }

  // Resolved once; a failed default-path lookup is retried by the next caller.
  private catalogLocation(): Promise<string> {
    this.location ??= (
      this.configuredPath === undefined
        ? Catalog.defaultPath()
        : Promise.resolve(this.configuredPath)
    ).catch((error: unknown) => {
      this.location = undefined
      throw error
    })
    return this.location
  }

  // A catalog that finishes opening after unload is closed instead of kept.
  private assertLive(value: Catalog | undefined): void {
    if (!this.disposed) return
    value?.close()
    throw new WorkspaceError("PLUGIN_DISPOSED", "Workspace plugin was unloaded")
  }
}
