import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type {
  AttachmentValue,
  FieldLike,
  LinkRef,
  SelectOption,
  TableLike,
  UserRef,
} from "./types.js";

/**
 * Network-backed capabilities the host app provides. Every member is
 * optional: editors degrade gracefully (e.g. no upload button) when absent.
 */
export interface FieldUiServices {
  /** Records of `tableId` matching `query` (empty query = first page). */
  searchRecords?(tableId: string, query: string): Promise<LinkRef[]>;
  /** Create a record in `tableId` whose primary field is `name`. */
  createRecord?(tableId: string, name: string): Promise<LinkRef>;
  /** Base collaborators for the collaborator picker. */
  listCollaborators?(): Promise<UserRef[]>;
  /** Upload a file and return the attachment wire object. */
  uploadAttachment?(file: File, onProgress?: (fraction: number) => void): Promise<AttachmentValue>;
  /** Add an option to a select field's config; resolves with the new option. */
  createSelectOption?(field: FieldLike, label: string): Promise<SelectOption>;
  /** Tables of the base (used by link pickers and config editors). */
  tables?: TableLike[];
}

const Ctx = createContext<FieldUiServices>({});

export function FieldUiServicesProvider({
  value,
  children,
}: {
  value: FieldUiServices;
  children: ReactNode;
}): ReactElement {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFieldUiServices(): FieldUiServices {
  return useContext(Ctx);
}
