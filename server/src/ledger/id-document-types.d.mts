export type IdDocumentType = {
  name: string;
  photo: boolean;
  noExpiryAllowed: boolean;
  accepted: boolean;
};

export const ID_DOCUMENT_TYPES: IdDocumentType[];

export function idDocumentTypeJoinSql(): string;
export function currentPhotoSql(dateExpr: string): string;
export function expiredPhotoSql(dateExpr: string): string;
export function photoMissingExpirySql(): string;
export function currentNonPhotoSql(dateExpr: string): string;
export function nonPhotoSql(): string;
