/** Minimal structural types so field-ui can be used by web, public and other apps. */

export interface FieldLike {
  id: string;
  name: string;
  type: string;
  config?: Record<string, unknown> | null | undefined;
  description?: string | null | undefined;
  isPrimary?: boolean | undefined;
  isComputed?: boolean | undefined;
}

export interface TableLike {
  id: string;
  name: string;
  primaryFieldId?: string | undefined;
  fields: FieldLike[];
}

export interface SelectOption {
  id: string;
  label: string;
  color?: string | undefined;
}

export interface UserRef {
  id: string;
  name?: string | null | undefined;
  email?: string | null | undefined;
}

export interface AttachmentValue {
  id: string;
  filename: string;
  mime?: string | null | undefined;
  size?: number | null | undefined;
  url?: string | null | undefined;
  thumbnailUrl?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
}

export interface LinkRef {
  id: string;
  name?: string | null | undefined;
}

export type FieldTypeGroup = "basic" | "advanced" | "computed" | "meta";

export interface FieldTypeInfo {
  type: string;
  label: string;
  icon: string;
  description: string;
  group: FieldTypeGroup;
  readOnly: boolean;
}
