/** Authorization subject — matches architecture §20.3 (MVP subset). */
export type Principal =
  | { type: "user"; id: string }
  | { type: "team"; id: string }
  | { type: "service_account"; id: string }
  | { type: "share_link"; id: string }
  | { type: "public_form"; id: string };

export const PrincipalTypes = [
  "user",
  "team",
  "service_account",
  "share_link",
  "public_form",
] as const;

export type PrincipalType = (typeof PrincipalTypes)[number];
