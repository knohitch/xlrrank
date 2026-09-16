import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { getDb } from "@xlrrank/database";
import { users } from "@xlrrank/database/schema";
import { assignRole, getRolesForUser } from "@xlrrank/database";
import type { Role } from "@xlrrank/auth";
import { hashPassword, verifyPassword } from "@xlrrank/auth";

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  emailVerified: boolean;
  roles: Role[];
  createdAt: Date;
}

function toPublicUser(
  u: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    status: string;
    emailVerifiedAt: Date | null;
    createdAt: Date;
  },
  roles: Role[],
): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    status: u.status,
    emailVerified: !!u.emailVerifiedAt,
    roles,
    createdAt: u.createdAt,
  };
}

export function normalizeUserAvatarUrl(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException("Avatar URL must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BadRequestException("Avatar URL must use HTTP(S).");
  }
  parsed.hash = "";
  return parsed.toString();
}

@Injectable()
export class UsersService {
  async findByEmail(email: string) {
    const db = getDb();
    const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    return rows[0] ?? null;
  }

  async findById(id: string) {
    const db = getDb();
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async createUser(data: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<PublicUser> {
    const db = getDb();
    const normalized = data.email.toLowerCase();
    const existing = await this.findByEmail(normalized);
    if (existing) {
      throw new ConflictException("An account with this email already exists.");
    }
    const passwordHash = await hashPassword(data.password);
    const inserted = await db
      .insert(users)
      .values({
        email: normalized,
        passwordHash,
        displayName: data.displayName,
        status: "PENDING_VERIFICATION",
      })
      .returning();
    const user = inserted[0];
    if (!user) throw new Error("User creation failed.");
    await assignRole(user.id, "USER");
    const roles = await getRolesForUser(user.id);
    return toPublicUser(user, roles);
  }

  async getPublicUser(id: string): Promise<PublicUser> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found.");
    const roles = await getRolesForUser(user.id);
    return toPublicUser(user, roles);
  }

  async updateProfile(
    id: string,
    data: { displayName?: string; avatarUrl?: string | null },
  ): Promise<PublicUser> {
    const db = getDb();
    const user = await this.findById(id);
    if (!user) throw new NotFoundException("User not found.");
    const updated = await db
      .update(users)
      .set({
        displayName: data.displayName ?? user.displayName,
        avatarUrl:
          data.avatarUrl === undefined ? user.avatarUrl : normalizeUserAvatarUrl(data.avatarUrl),
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning();
    const result = updated[0];
    if (!result) throw new NotFoundException("User not found.");
    const roles = await getRolesForUser(result.id);
    return toPublicUser(result, roles);
  }

  async changePassword(id: string, newPassword: string): Promise<void> {
    const db = getDb();
    const passwordHash = await hashPassword(newPassword);
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, id));
  }

  async verifyPasswordForUser(id: string, password: string): Promise<boolean> {
    const user = await this.findById(id);
    if (!user) return false;
    return verifyPassword(password, user.passwordHash);
  }

  async setStatus(
    id: string,
    status: "ACTIVE" | "PENDING_VERIFICATION" | "SUSPENDED" | "DISABLED" | "DELETION_PENDING",
  ): Promise<void> {
    const db = getDb();
    await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, id));
  }

  async markEmailVerified(id: string): Promise<void> {
    const db = getDb();
    await db
      .update(users)
      .set({ status: "ACTIVE", emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, id));
  }

  async recordLogin(id: string): Promise<void> {
    const db = getDb();
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  async deleteUser(id: string): Promise<void> {
    const db = getDb();
    await db.delete(users).where(eq(users.id, id));
  }
}
