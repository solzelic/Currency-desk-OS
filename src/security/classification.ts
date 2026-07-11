export type DataClassification = "public" | "internal" | "confidential" | "restricted";

export interface DataClassificationMetadata {
  classification: DataClassification;
  description: string;
  examples: readonly string[];
  productionHandling: string;
}

export const dataClassificationCatalog: Readonly<Record<DataClassification, DataClassificationMetadata>> = {
  public: {
    classification: "public",
    description: "Information approved for public release.",
    examples: ["published exchange rates", "public branch contact details"],
    productionHandling: "Integrity controls and approved publishing workflow."
  },
  internal: {
    classification: "internal",
    description: "Routine operational information for authorized personnel.",
    examples: ["workspace configuration", "non-sensitive support logs"],
    productionHandling: "Authenticated access and standard operational logging."
  },
  confidential: {
    classification: "confidential",
    description: "Business or customer information requiring limited access.",
    examples: ["transaction records", "receipts", "commercial rate configuration"],
    productionHandling: "Role-based access, encryption, and audited export controls."
  },
  restricted: {
    classification: "restricted",
    description: "Highest-impact identity, KYC, authentication, or regulatory data.",
    examples: ["identity documents", "screening evidence", "credentials and secrets"],
    productionHandling: "Strict least privilege, dedicated encrypted storage, and access monitoring."
  }
};

export const recordClassifications = {
  workspace: "internal",
  staff: "confidential",
  customer: "restricted",
  transaction: "confidential",
  receipt: "confidential",
  auditEvent: "confidential",
  kycDocument: "restricted"
} as const satisfies Record<string, DataClassification>;
