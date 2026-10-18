/**
 * Central permission engine. Every critical action is authorized here on the server,
 * independent of which buttons Telegram showed. Telegram buttons are never access control.
 */

export const ROLES = ['buyer', 'seller', 'arbiter', 'mediator', 'observer'] as const;
export type Role = (typeof ROLES)[number];
export const SIGNING_ROLES: ReadonlySet<Role> = new Set(['buyer', 'seller', 'arbiter']);

export const ROLE_LABEL_DE: Record<Role, string> = {
  buyer: 'Käufer',
  seller: 'Verkäufer',
  arbiter: 'Schlichter',
  mediator: 'Vermittler',
  observer: 'Beobachter',
};

export type Action =
  | 'view_trade'
  | 'view_participants'
  | 'view_payment_details'
  | 'invite'
  | 'revoke_invite'
  | 'agree_terms'
  | 'register_key'
  | 'verify_address'
  | 'cancel_trade'
  | 'mark_delivered'
  | 'request_release'
  | 'request_refund'
  | 'sign_psbt'
  | 'open_dispute'
  | 'view_dispute'
  | 'decide_dispute'
  | 'link_group';

const MATRIX: Record<Role, ReadonlySet<Action>> = {
  buyer: new Set<Action>([
    'view_trade',
    'view_participants',
    'view_payment_details',
    'invite',
    'revoke_invite',
    'agree_terms',
    'register_key',
    'verify_address',
    'cancel_trade',
    'request_release',
    'sign_psbt',
    'open_dispute',
    'view_dispute',
    'link_group',
  ]),
  seller: new Set<Action>([
    'view_trade',
    'view_participants',
    'view_payment_details',
    'invite',
    'revoke_invite',
    'agree_terms',
    'register_key',
    'verify_address',
    'cancel_trade',
    'mark_delivered',
    'request_refund',
    'sign_psbt',
    'open_dispute',
    'view_dispute',
    'link_group',
  ]),
  arbiter: new Set<Action>([
    'view_trade',
    'view_participants',
    'view_payment_details',
    'agree_terms',
    'register_key',
    'verify_address',
    'sign_psbt',
    'view_dispute',
    'decide_dispute',
  ]),
  mediator: new Set<Action>(['view_trade', 'view_participants', 'view_dispute']),
  observer: new Set<Action>(['view_trade']),
};

export function isRole(r: string): r is Role {
  return (ROLES as readonly string[]).includes(r);
}

export function can(role: Role | null, action: Action): boolean {
  return role !== null && MATRIX[role].has(action);
}

/** Admins moderate and support; they never get signing or payment-related permissions. */
const ADMIN_ACTIONS: ReadonlySet<Action> = new Set(['view_trade', 'view_participants', 'view_dispute']);
export function adminCan(action: Action): boolean {
  return ADMIN_ACTIONS.has(action);
}

export class PermissionError extends Error {
  override name = 'PermissionError';
  constructor(message = 'Keine Berechtigung für diese Aktion') {
    super(message);
  }
}

export function requirePermission(role: Role | null, action: Action, isAdmin = false): void {
  if (can(role, action) || (isAdmin && adminCan(action))) return;
  throw new PermissionError();
}
