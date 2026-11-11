import { join } from "node:path";
import { amoHome, type Env } from "./paths.js";
import { readJsonFile, updateJsonFile } from "./json.js";

export interface CooperationPolicy { relayEnabled: boolean; serverEnabled: boolean; serverLan: boolean; syncOwnDevices: boolean }
export const cooperationFile = (env?: Env) => join(amoHome(env), "cooperation.json");
export function readCooperation(env?: Env): CooperationPolicy {
  const p = readJsonFile<Partial<CooperationPolicy>>(cooperationFile(env));
  return { relayEnabled: p?.relayEnabled === true, serverEnabled: p?.serverEnabled === true, serverLan: p?.serverLan === true, syncOwnDevices: p?.syncOwnDevices === true };
}
export function updateCooperation(patch: Partial<CooperationPolicy>, env?: Env): CooperationPolicy {
  const next = { ...readCooperation(env), ...patch };
  updateJsonFile(cooperationFile(env), () => next);
  return next;
}
