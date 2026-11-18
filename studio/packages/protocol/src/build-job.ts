/** The Jenkins jobs approved by this workstation's owner. Never accepts a URL from chat. */
export const BUILD_JOB_URL = "http://172.16.8.85:8080/job/SurvivorTD_IOS_Auto/";
const JENKINS = "http://172.16.8.85:8080/job/";
/** `confirm`: a whole or base package takes long and occupies the build machine, so its button asks for a second click. */
export const BUILD_JOBS = {
  ios: { label: "打ios整包", platform: "ios", name: "SurvivorTD_IOS_Auto", url: BUILD_JOB_URL, confirm: true },
  ios_base: { label: "打ios热更母包", platform: "ios", name: "SurvivorTD_IOS", url: `${JENKINS}SurvivorTD_IOS/`, confirm: true },
  ios_hotfix: { label: "出ios热更新资源", platform: "ios", name: "SurvivorTD_IOS_Hotfix", url: `${JENKINS}SurvivorTD_IOS_Hotfix/`, confirm: false },
  android: { label: "打安卓整包", platform: "android", name: "SurvivorTD_Android_Auto", url: `${JENKINS}SurvivorTD_Android_Auto/`, confirm: true },
  android_base: { label: "出安卓热更母包", platform: "android", name: "SurvivorTD_Android", url: `${JENKINS}SurvivorTD_Android/`, confirm: true },
  android_hotfix: { label: "出安卓热更新资源", platform: "android", name: "SurvivorTD_Android_Hotfix", url: `${JENKINS}SurvivorTD_Android_Hotfix/`, confirm: false },
} as const;
export type BuildJobId = keyof typeof BUILD_JOBS;
export const BUILD_JOB_IDS = Object.keys(BUILD_JOBS) as BuildJobId[];
export const isBuildJobId = (value: unknown): value is BuildJobId => typeof value === "string" && Object.hasOwn(BUILD_JOBS, value);
/** `notified`: the failure notice (@WNY through 中转, or a local popup) went out once. */
export interface BuildRun { status: "queued" | "running" | "success" | "failed" | "unknown"; job?: BuildJobId; message: string; url: string; queueUrl?: string; sessionId?: string; updatedAt: string; analysisPrompt?: string; analysisQueued?: boolean; errorLog?: string; notified?: string }
/** `runs`: each job's latest run (jobs run side by side); `last`: the most recent of them. */
export interface BuildJobState { jobUrl: string; jobs: typeof BUILD_JOBS; username: string; credentialSaved: boolean; enabled: boolean; last: BuildRun | null; runs: Partial<Record<BuildJobId, BuildRun>> }
export interface BuildJobRoutes {
  "GET /api/build-job": { req: never; res: BuildJobState };
  "PUT /api/build-job": { req: { username: string; token?: string; enabled: boolean; clear?: boolean }; res: BuildJobState };
  "POST /api/build-job/run": { req: { job?: BuildJobId } | void; res: BuildJobState };
  "POST /api/build-job/check": { req: never; res: BuildJobState };
}
