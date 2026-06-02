/**
 * Minimal Node.js global ambient declarations for ADR-457 build-at-publish
 * TS sources that reference node runtime globals (process, require, module).
 *
 * Kept minimal on purpose: the tsconfig.build.json sets "types": [] to avoid
 * global namespace pollution. Only the subset actually used by src/*.cts is
 * declared here. If @types/node is ever added as a devDependency, this file
 * should be removed and "types": ["node"] added to tsconfig.build.json instead.
 */

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  stdin: {
    setEncoding(encoding: string): void;
    on(event: 'data', listener: (chunk: string) => void): void;
    on(event: 'end', listener: () => void): void;
    on(event: 'error', listener: (err: Error) => void): void;
  };
  stderr: {
    write(s: string): void;
  };
};

declare const require: {
  main: NodeModule | undefined;
};

declare const module: NodeModule;

interface NodeModule {
  id: string;
  filename: string;
  loaded: boolean;
  parent: NodeModule | null;
  children: NodeModule[];
  exports: unknown;
  require(id: string): unknown;
  paths: string[];
}
