import * as fs from "node:fs";
import * as path from "node:path";
import {
  RepoConfig,
  RepoConfigSchema,
  StacksState,
  StacksStateSchema,
  BranchRelationship,
  PendingOps,
  PendingOpsSchema,
  PendingOperation,
} from "./schemas.js";

export class StateManager {
  private pileDir: string;

  constructor(repoRoot: string) {
    this.pileDir = path.join(repoRoot, ".pile");
  }

  private ensurePileDir(): void {
    if (!fs.existsSync(this.pileDir)) {
      fs.mkdirSync(this.pileDir, { recursive: true });
    }
  }

  private readJsonFile<T>(filename: string, schema: { parse: (data: unknown) => T }, defaultValue: T): T {
    const filePath = path.join(this.pileDir, filename);
    try {
      if (!fs.existsSync(filePath)) {
        return defaultValue;
      }
      const content = fs.readFileSync(filePath, "utf-8");
      return schema.parse(JSON.parse(content));
    } catch {
      return defaultValue;
    }
  }

  private writeJsonFile(filename: string, data: unknown): void {
    this.ensurePileDir();
    const filePath = path.join(this.pileDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  isInitialized(): boolean {
    const configPath = path.join(this.pileDir, "config.json");
    if (!fs.existsSync(configPath)) {
      return false;
    }
    const config = this.getConfig();
    return config?.initialized ?? false;
  }

  getConfig(): RepoConfig | null {
    return this.readJsonFile("config.json", RepoConfigSchema, null as unknown as RepoConfig);
  }

  saveConfig(config: RepoConfig): void {
    this.writeJsonFile("config.json", config);
  }

  getStacksState(): StacksState {
    return this.readJsonFile("stacks.json", StacksStateSchema, { branches: {} });
  }

  saveStacksState(state: StacksState): void {
    this.writeJsonFile("stacks.json", state);
  }

  getBranchRelationship(branchName: string): BranchRelationship | null {
    const state = this.getStacksState();
    return state.branches[branchName] ?? null;
  }

  setBranchRelationship(branchName: string, relationship: BranchRelationship): void {
    const state = this.getStacksState();
    state.branches[branchName] = relationship;
    this.saveStacksState(state);
  }

  removeBranchRelationship(branchName: string): void {
    const state = this.getStacksState();
    delete state.branches[branchName];
    this.saveStacksState(state);
  }

  getParent(branchName: string): string | null {
    const rel = this.getBranchRelationship(branchName);
    return rel?.parent ?? null;
  }

  getChildren(branchName: string): string[] {
    const state = this.getStacksState();
    return Object.values(state.branches)
      .filter((rel) => rel.parent === branchName)
      .map((rel) => rel.name);
  }

  getAllTrackedBranches(): string[] {
    const state = this.getStacksState();
    return Object.keys(state.branches);
  }

  getPendingOps(): PendingOps {
    return this.readJsonFile("pending-ops.json", PendingOpsSchema, { operations: [] });
  }

  savePendingOps(ops: PendingOps): void {
    this.writeJsonFile("pending-ops.json", ops);
  }

  queueOperation(op: Omit<PendingOperation, "id" | "createdAt" | "retries">): void {
    const ops = this.getPendingOps();
    const newOp: PendingOperation = {
      ...op,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      retries: 0,
    };
    ops.operations.push(newOp);
    this.savePendingOps(ops);
  }

  removeOperation(id: string): void {
    const ops = this.getPendingOps();
    ops.operations = ops.operations.filter((op) => op.id !== id);
    this.savePendingOps(ops);
  }

  incrementOperationRetry(id: string): void {
    const ops = this.getPendingOps();
    const op = ops.operations.find((o) => o.id === id);
    if (op) {
      op.retries += 1;
    }
    this.savePendingOps(ops);
  }

  hasPendingOperations(): boolean {
    const ops = this.getPendingOps();
    return ops.operations.length > 0;
  }

  getPendingOperationCount(): number {
    const ops = this.getPendingOps();
    return ops.operations.length;
  }
}

export function createStateManager(repoRoot: string): StateManager {
  return new StateManager(repoRoot);
}
