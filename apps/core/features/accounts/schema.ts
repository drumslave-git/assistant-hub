import { z } from "zod";

import { MIN_PASSWORD_LENGTH, MIN_USERNAME_LENGTH, USERNAME_PATTERN } from "@/lib/auth";

/**
 * Account-management contracts (redesign Phase 8): what an admin sees of an
 * account, and the create/patch inputs. Client-safe — no hashes or secrets
 * ever cross this boundary.
 */

/** One account as the management page renders it. Never the secrets. */
export const accountViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(["admin", "user"]),
  active: z.boolean(),
  /** True while the account still holds its admin-issued temporary password. */
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
});

export type AccountView = z.infer<typeof accountViewSchema>;

const usernameSchema = z
  .string()
  .trim()
  .min(MIN_USERNAME_LENGTH, {
    message: `Username must be at least ${MIN_USERNAME_LENGTH} characters`,
  })
  .regex(USERNAME_PATTERN, {
    message: "Username may contain only letters, digits, dots, dashes and underscores",
  });

const temporaryPasswordSchema = z.string().min(MIN_PASSWORD_LENGTH, {
  message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
});

/**
 * POST /api/accounts — an admin creates an account with a temporary password
 * (handed over out of band); the account must replace it at first sign-in.
 */
export const createAccountSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().max(120).optional(),
  role: z.enum(["admin", "user"]),
  temporaryPassword: temporaryPasswordSchema,
});

export type CreateAccount = z.infer<typeof createAccountSchema>;

/**
 * PATCH /api/accounts/:id — one management action per call (the dashboard
 * saves each on its own): activate/deactivate, change the role, or hand the
 * account a fresh temporary password.
 */
export const patchAccountSchema = z.union([
  z.object({ active: z.boolean() }),
  z.object({ role: z.enum(["admin", "user"]) }),
  z.object({ temporaryPassword: temporaryPasswordSchema }),
]);

export type PatchAccount = z.infer<typeof patchAccountSchema>;
