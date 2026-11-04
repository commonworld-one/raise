/** An error with an HTTP status and a machine code, answered as JSON by the API and MCP. */
export class ActionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
