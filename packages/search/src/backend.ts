export interface SearchDocument {
  workspaceId: string;
  baseId: string;
  docType: string;
  refId: string;
  title: string;
  body: string;
}

export interface SearchHit {
  id: string;
  workspaceId: string;
  baseId: string;
  docType: string;
  refId: string;
  title: string;
  rank: number;
}

export interface SearchBackend {
  upsert(doc: SearchDocument): Promise<void>;
  remove(baseId: string, docType: string, refId: string): Promise<void>;
  search(params: {
    query: string;
    baseIds: string[];
    limit?: number;
  }): Promise<SearchHit[]>;
}
