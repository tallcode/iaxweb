export class UserManagementError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409, message: string) {
    super(message)
  }
}
