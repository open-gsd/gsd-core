'use strict';

import fs from 'node:fs';

const OPENCODE_SERVICE_VERSIONS = Object.freeze(['2.0.2', '2.0.3']);
const RPC_ID = 'gsd-worktree-task.attestation.v1';
const RPC_METHOD = 'status';
const PROVENANCE = 'opencode_plugin_rpc_v1';
const RPC_TIMEOUT_MS = 10_000;
// Service and helper clocks are the same host clock, but scheduler boundaries
// can straddle adjacent ticks. This is transport validation, not merge freshness.
const OBSERVATION_CLOCK_TOLERANCE_MS = 1_000;

// This definition is intentionally portable and duplicated on the helper side.
// The plugin-side contract test must compare this ID, method, and schemas exactly.
const RPC_DEFINITION_VALUE = Object.freeze({
  id: RPC_ID,
  methods: Object.freeze({
    [RPC_METHOD]: Object.freeze({
      input: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          parent_session_id: Object.freeze({ type: 'string' }),
          wave_id: Object.freeze({ type: 'string' }),
        }),
        required: Object.freeze(['parent_session_id', 'wave_id']),
        additionalProperties: false,
      }),
      output: Object.freeze({
        type: 'object',
        properties: Object.freeze({
          wave_id: Object.freeze({ type: 'string' }),
          parent_session_id: Object.freeze({ type: 'string' }),
          checked_at: Object.freeze({ type: 'integer' }),
          sealed: Object.freeze({ type: 'boolean' }),
          merge_ready: Object.freeze({ type: 'boolean' }),
          reasons: Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) }),
          jobs: Object.freeze({ type: 'array', items: Object.freeze({
            type: 'object',
            properties: Object.freeze({
              session_id: Object.freeze({ type: 'string' }),
              directory: Object.freeze({ type: 'string' }),
              status: Object.freeze({ type: 'string' }),
              agent: Object.freeze({ type: 'string' }),
              model: Object.freeze({
                type: 'object',
                properties: Object.freeze({
                  providerID: Object.freeze({ type: 'string' }),
                  id: Object.freeze({ type: 'string' }),
                  variant: Object.freeze({ type: 'string' }),
                }),
                required: Object.freeze(['providerID', 'id', 'variant']),
                additionalProperties: false,
              }),
              manifest_path: Object.freeze({ type: 'string' }),
              manifest_agent_id: Object.freeze({ type: 'string' }),
              manifest_entry: Object.freeze({
                type: 'object',
                properties: Object.freeze({
                  agent_id: Object.freeze({ type: 'string' }),
                  worktree_path: Object.freeze({ type: 'string' }),
                  branch: Object.freeze({ type: 'string' }),
                  expected_base: Object.freeze({ type: 'string' }),
                  files_modified: Object.freeze({}),
                  declared_deletions: Object.freeze({}),
                }),
                required: Object.freeze(['agent_id', 'worktree_path', 'branch', 'expected_base', 'files_modified', 'declared_deletions']),
                additionalProperties: false,
              }),
              manifest_entry_hash: Object.freeze({ type: 'string' }),
              started_at: Object.freeze({ type: 'number' }),
              deadline: Object.freeze({ type: 'number' }),
              finished_at: Object.freeze({ type: 'number' }),
              text: Object.freeze({ type: 'string' }),
              error: Object.freeze({ type: 'string' }),
              cleanup_error: Object.freeze({ type: 'string' }),
              requested_executor: Object.freeze({
                type: 'object',
                properties: Object.freeze({
                  session_id: Object.freeze({ type: 'string' }),
                  parent_session_id: Object.freeze({ type: 'string' }),
                  directory: Object.freeze({ type: 'string' }),
                  manifest_agent_id: Object.freeze({ type: 'string' }),
                  agent: Object.freeze({ type: 'string' }),
                  model: Object.freeze({
                    type: 'object',
                    properties: Object.freeze({ providerID: Object.freeze({ type: 'string' }), id: Object.freeze({ type: 'string' }), variant: Object.freeze({ type: 'string' }) }),
                    required: Object.freeze(['providerID', 'id', 'variant']),
                    additionalProperties: false,
                  }),
                  final_permission: Object.freeze({
                    type: 'object',
                    properties: Object.freeze({ action: Object.freeze({ type: 'string' }), resource: Object.freeze({ type: 'string' }), effect: Object.freeze({ type: 'string' }) }),
                    required: Object.freeze(['action', 'resource', 'effect']),
                    additionalProperties: false,
                  }),
                }),
                required: Object.freeze(['session_id', 'parent_session_id', 'directory', 'manifest_agent_id', 'agent', 'model', 'final_permission']),
                additionalProperties: false,
              }),
              observed_executor: Object.freeze({ oneOf: [Object.freeze({
                type: 'object',
                properties: Object.freeze({
                  session_id: Object.freeze({ type: 'string' }),
                  parent_session_id: Object.freeze({ type: 'string' }),
                  directory: Object.freeze({ type: 'string' }),
                  agent: Object.freeze({ type: 'string' }),
                  model: Object.freeze({
                    type: 'object',
                    properties: Object.freeze({ providerID: Object.freeze({ type: 'string' }), id: Object.freeze({ type: 'string' }), variant: Object.freeze({ type: 'string' }) }),
                    required: Object.freeze(['providerID', 'id', 'variant']),
                    additionalProperties: false,
                  }),
                  outcome: Object.freeze({ type: 'string' }),
                  final_permission: Object.freeze({
                    type: 'object',
                    properties: Object.freeze({ action: Object.freeze({ type: 'string' }), resource: Object.freeze({ type: 'string' }), effect: Object.freeze({ type: 'string' }) }),
                    required: Object.freeze(['action', 'resource', 'effect']),
                    additionalProperties: false,
                  }),
                }),
                required: Object.freeze(['session_id', 'parent_session_id', 'directory', 'agent', 'model', 'outcome', 'final_permission']),
                additionalProperties: false,
              }), Object.freeze({ type: 'null' })] }),
            }),
            required: Object.freeze([
              'session_id', 'directory', 'status', 'agent', 'model', 'manifest_path', 'manifest_agent_id',
              'manifest_entry', 'manifest_entry_hash', 'requested_executor', 'observed_executor',
            ]),
            additionalProperties: false,
          }) }),
        }),
        required: Object.freeze(['wave_id', 'parent_session_id', 'checked_at', 'sealed', 'merge_ready', 'reasons', 'jobs']),
        additionalProperties: false,
      }),
      errors: Object.freeze({
        unknown_wave: Object.freeze({
          type: 'object',
          properties: Object.freeze({ parent_session_id: Object.freeze({ type: 'string' }), wave_id: Object.freeze({ type: 'string' }) }),
          required: Object.freeze(['parent_session_id', 'wave_id']),
          additionalProperties: false,
        }),
      }),
    }),
  }),
  events: Object.freeze({}),
});

interface AttestationRequest {
  project: string;
  parent_session_id: string;
  wave_id: string;
  session_id: string;
}

function compatibleVersion(version: string): boolean {
  return OPENCODE_SERVICE_VERSIONS.includes(version);
}

async function observe(request: AttestationRequest): Promise<unknown> {
  const project = fs.realpathSync(request.project);
  if (project !== request.project) throw new Error('attestation project must be canonical');

  const [{ OpenCode }, Service, { Rpc }] = await Promise.all([
    // These are production dependencies used by the installed OpenCode V2 path.
    // eslint-disable-next-line local/no-external-require-in-bin
    import('@opencode/client'),
    // eslint-disable-next-line local/no-external-require-in-bin
    import('@opencode/client/service'),
    // eslint-disable-next-line local/no-external-require-in-bin
    import('@opencode/schema/rpc'),
  ]);
  const endpoint = await Service.discover({ version: compatibleVersion });
  if (!endpoint) throw new Error('no compatible managed OpenCode service is discoverable');
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const health = await client.health.get({ signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (health?.healthy !== true || !compatibleVersion(health.version)) {
    throw new Error('discovered OpenCode service failed health/version compatibility');
  }

  const definition = Rpc.define(RPC_DEFINITION_VALUE);
  const rpc = client.rpc(definition);
  const requestStartedAt = Date.now();
  const evidence = await rpc[RPC_METHOD]({
    parent_session_id: request.parent_session_id,
    wave_id: request.wave_id,
  }, { location: { directory: project }, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  const requestFinishedAt = Date.now();
  return {
    evidence,
    provenance: {
      source: PROVENANCE,
      rpc_id: RPC_ID,
      rpc_method: RPC_METHOD,
      service_version: health.version,
      request_started_at: requestStartedAt,
      request_finished_at: requestFinishedAt,
    },
  };
}

export = {
  OPENCODE_SERVICE_VERSIONS,
  RPC_ID,
  RPC_METHOD,
  PROVENANCE,
  RPC_TIMEOUT_MS,
  OBSERVATION_CLOCK_TOLERANCE_MS,
  RPC_DEFINITION_VALUE,
  compatibleVersion,
  observe,
};
