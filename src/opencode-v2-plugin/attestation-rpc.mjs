import { Rpc } from "@opencode/schema/rpc";

export const ATTESTATION_RPC_ID = "gsd-worktree-task.attestation.v1";

export const ATTESTATION_RPC_INPUT_SCHEMA = {
  type: "object",
  properties: {
    parent_session_id: { type: "string" },
    wave_id: { type: "string" },
  },
  required: ["parent_session_id", "wave_id"],
  additionalProperties: false,
};

export function assertAttestationRPCInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("attestation RPC input must be an object");
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "parent_session_id" || keys[1] !== "wave_id") {
    throw new Error("attestation RPC input must contain only parent_session_id and wave_id");
  }
  if (!Object.hasOwn(input, "parent_session_id") || typeof input.parent_session_id !== "string" || !/^ses/.test(input.parent_session_id)) {
    throw new Error("attestation RPC parent_session_id is invalid");
  }
  if (!Object.hasOwn(input, "wave_id") || typeof input.wave_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.wave_id)) {
    throw new Error("attestation RPC wave_id is invalid");
  }
}

const MODEL_SCHEMA = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "id", "variant"],
  additionalProperties: false,
};

const PERMISSION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string" },
    resource: { type: "string" },
    effect: { type: "string" },
  },
  required: ["action", "resource", "effect"],
  additionalProperties: false,
};

const REQUESTED_EXECUTOR_SCHEMA = {
  type: "object",
  properties: {
    session_id: { type: "string" },
    parent_session_id: { type: "string" },
    directory: { type: "string" },
    manifest_agent_id: { type: "string" },
    agent: { type: "string" },
    model: MODEL_SCHEMA,
    final_permission: PERMISSION_SCHEMA,
  },
  required: ["session_id", "parent_session_id", "directory", "manifest_agent_id", "agent", "model", "final_permission"],
  additionalProperties: false,
};

const OBSERVED_EXECUTOR_SCHEMA = {
  type: "object",
  properties: {
    session_id: { type: "string" },
    parent_session_id: { type: "string" },
    directory: { type: "string" },
    agent: { type: "string" },
    model: MODEL_SCHEMA,
    outcome: { type: "string" },
    final_permission: PERMISSION_SCHEMA,
  },
  required: ["session_id", "parent_session_id", "directory", "agent", "model", "outcome", "final_permission"],
  additionalProperties: false,
};

const MANIFEST_ENTRY_SCHEMA = {
  type: "object",
  properties: {
    agent_id: { type: "string" },
    worktree_path: { type: "string" },
    branch: { type: "string" },
    expected_base: { type: "string" },
    files_modified: {},
    declared_deletions: {},
  },
  required: ["agent_id", "worktree_path", "branch", "expected_base", "files_modified", "declared_deletions"],
  additionalProperties: false,
};

const JOB_SCHEMA = {
  type: "object",
  properties: {
    session_id: { type: "string" },
    directory: { type: "string" },
    status: { type: "string" },
    agent: { type: "string" },
    model: MODEL_SCHEMA,
    manifest_path: { type: "string" },
    manifest_agent_id: { type: "string" },
    manifest_entry: MANIFEST_ENTRY_SCHEMA,
    manifest_entry_hash: { type: "string" },
    started_at: { type: "number" },
    deadline: { type: "number" },
    finished_at: { type: "number" },
    text: { type: "string" },
    error: { type: "string" },
    cleanup_error: { type: "string" },
    requested_executor: REQUESTED_EXECUTOR_SCHEMA,
    observed_executor: { oneOf: [OBSERVED_EXECUTOR_SCHEMA, { type: "null" }] },
  },
  required: [
    "session_id", "directory", "status", "agent", "model", "manifest_path", "manifest_agent_id",
    "manifest_entry", "manifest_entry_hash", "requested_executor", "observed_executor",
  ],
  additionalProperties: false,
};

export const ATTESTATION_RPC_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    wave_id: { type: "string" },
    parent_session_id: { type: "string" },
    checked_at: { type: "integer" },
    sealed: { type: "boolean" },
    merge_ready: { type: "boolean" },
    reasons: { type: "array", items: { type: "string" } },
    jobs: { type: "array", items: JOB_SCHEMA },
  },
  required: ["wave_id", "parent_session_id", "checked_at", "sealed", "merge_ready", "reasons", "jobs"],
  additionalProperties: false,
};

// This uses only the JSON Schema RPC surface shared by 2.0.2 and 2.0.3. A
// real 2.0.2 service remains the required runtime compatibility proof.
export const ATTESTATION_RPC = Rpc.define({
  id: ATTESTATION_RPC_ID,
  methods: {
    status: {
      input: ATTESTATION_RPC_INPUT_SCHEMA,
      output: ATTESTATION_RPC_OUTPUT_SCHEMA,
      errors: {
        unknown_wave: {
          type: "object",
          properties: {
            parent_session_id: { type: "string" },
            wave_id: { type: "string" },
          },
          required: ["parent_session_id", "wave_id"],
          additionalProperties: false,
        },
      },
    },
  },
  events: {},
});
