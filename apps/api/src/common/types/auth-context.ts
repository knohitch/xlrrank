import type { Role } from "@xlrrank/auth";

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  roles: Role[];
  status: string;
}

export interface RequestWithAuth extends Request {
  auth?: AuthContext;
  rawBody?: string;
}
