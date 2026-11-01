/** An edit's expected content no longer matches the file: it changed on disk since the renderer read it. */
export class StaleEdit extends Error {
  constructor(message = 'Changed on disk') {
    super(message)
    this.name = 'StaleEdit'
  }
}
