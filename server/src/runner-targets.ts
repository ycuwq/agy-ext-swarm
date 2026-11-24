import { MAX_WORKER_NAME_LEN, validateWorkerName } from './mentions.js';
import { pickRoutedTarget } from './runner-routing.js';
import type {
  PermissionMode,
  ProvidersConfigSnapshot,
  SwarmState,
  TaskRoutingCategory,
} from './types.js';

export interface WorkerTarget {
  name: string;
  taskText: string;
  providerId: string;
  routedModel?: string;
}

export interface PlanWorkerTargetsInput {
  swarm: SwarmState;
  providerSnap: ProvidersConfigSnapshot;
  name: string;
  brief: string;
  tasks?: string[];
  provider?: string;
  providers?: string[];
  customCommand?: unknown;
  permissionMode: PermissionMode;
  category: TaskRoutingCategory;
}

export interface PlanWorkerTargetsResult {
  targets: WorkerTarget[];
  nextRrCursor: number;
  usedRouter: boolean;
}

/**
 * Resolves the concrete worker names, provider assignments and task texts for a
 * single add_worker call (task sharding, explicit provider fan-out, or single
 * worker). Pure apart from reading the router cursor from `swarm.rrCursor`.
 */
export function planWorkerTargets(input: PlanWorkerTargetsInput): PlanWorkerTargetsResult {
  const { swarm, providerSnap, permissionMode, category } = input;
  const explicitProviders = (input.providers || [])
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const explicitSingle = input.provider?.trim().toLowerCase();
  const targets: WorkerTarget[] = [];
  let nextRrCursor = swarm.rrCursor || 0;
  let usedRouter = false;

  if (input.tasks && input.tasks.length > 0) {
    const baseCheck = validateWorkerName(input.name);
    if (!baseCheck.valid) {
      throw new Error(baseCheck.error);
    }
    for (let i = 0; i < input.tasks.length; i++) {
      const shardName = `${baseCheck.normalized}-${i + 1}`;
      const shardCheck = validateWorkerName(shardName);
      if (!shardCheck.valid) {
        throw new Error(shardCheck.error);
      }
      let providerId: string;
      let routedModel: string | undefined;
      if (explicitProviders.length > 0) {
        providerId = explicitProviders[i % explicitProviders.length];
      } else if (explicitSingle) {
        providerId = explicitSingle;
      } else if (input.customCommand) {
        providerId = 'custom';
      } else {
        const picked = pickRoutedTarget(
          swarm,
          permissionMode,
          providerSnap,
          category,
          nextRrCursor,
        );
        providerId = picked.providerId;
        routedModel = picked.model;
        nextRrCursor = picked.nextCursor;
        usedRouter = true;
      }
      targets.push({
        name: shardCheck.normalized,
        taskText: `${input.brief}\n\nAssigned Slice (${i + 1}/${input.tasks.length}):\n${input.tasks[i]}`,
        providerId,
        routedModel,
      });
    }
  } else if (explicitProviders.length >= 2) {
    const baseCheck = validateWorkerName(input.name);
    if (!baseCheck.valid) {
      throw new Error(baseCheck.error);
    }
    const usedInCall = new Set<string>(Object.keys(swarm.members));
    for (const provId of explicitProviders) {
      const slug =
        provId.replace(/[^a-z0-9_-]+/g, '').slice(0, 12).replace(/[-_]+$/g, '') || 'cli';
      const maxBase = Math.max(1, MAX_WORKER_NAME_LEN - 1 - slug.length);
      const basePart = baseCheck.normalized.slice(0, maxBase).replace(/[-_]+$/g, '') || 'w';
      let fanName = `${basePart}-${slug}`.slice(0, MAX_WORKER_NAME_LEN).replace(/[-_]+$/g, '');
      if (usedInCall.has(fanName)) {
        let idx = 2;
        while (
          usedInCall.has(
            `${fanName.slice(0, Math.max(1, MAX_WORKER_NAME_LEN - 1 - String(idx).length)).replace(/[-_]+$/g, '')}-${idx}`,
          )
        ) {
          idx++;
        }
        fanName = `${fanName.slice(0, Math.max(1, MAX_WORKER_NAME_LEN - 1 - String(idx).length)).replace(/[-_]+$/g, '')}-${idx}`;
      }
      const check = validateWorkerName(fanName);
      if (!check.valid) {
        throw new Error(check.error);
      }
      usedInCall.add(check.normalized);
      targets.push({
        name: check.normalized,
        taskText: input.brief,
        providerId: provId,
      });
    }
  } else {
    const check = validateWorkerName(input.name);
    if (!check.valid) {
      throw new Error(check.error);
    }
    let providerId: string;
    let routedModel: string | undefined;
    if (explicitProviders[0] || explicitSingle) {
      providerId = explicitProviders[0] || explicitSingle!;
    } else if (input.customCommand) {
      providerId = 'custom';
    } else {
      const picked = pickRoutedTarget(
        swarm,
        permissionMode,
        providerSnap,
        category,
        nextRrCursor,
      );
      providerId = picked.providerId;
      routedModel = picked.model;
      nextRrCursor = picked.nextCursor;
      usedRouter = true;
    }
    targets.push({
      name: check.normalized,
      taskText: input.brief,
      providerId,
      routedModel,
    });
  }

  return { targets, nextRrCursor, usedRouter };
}
