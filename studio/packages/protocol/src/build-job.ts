/** The single Jenkins job approved by this workstation's owner. Never accepts a URL from chat. */
export const BUILD_JOB_URL = "http://172.16.8.85:8080/job/SurvivorTD_IOS_Auto/";
export const BUILD_JOBS = { ios: { label: "iOS", url: BUILD_JOB_URL }, android: { label: "安卓", url: "http://172.16.8.85:8080/job/SurvivorTD_Android_Auto/" } } as const;
export type BuildJobId = keyof typeof BUILD_JOBS;
export interface BuildRun { status: "queued" | "running" | "success" | "failed" | "unknown"; job?: BuildJobId; message: string; url: string; queueUrl?: string; sessionId?: string; updatedAt: string; analysisPrompt?: string; analysisQueued?: boolean; errorLog?: string }
export interface BuildJobState { jobUrl: string; jobs: typeof BUILD_JOBS; username: string; credentialSaved: boolean; enabled: boolean; last: BuildRun | null }
export interface BuildJobRoutes {
  "GET /api/build-job": { req: never; res: BuildJobState };
  "PUT /api/build-job": { req: { username: string; token?: string; enabled: boolean; clear?: boolean }; res: BuildJobState };
  "POST /api/build-job/run": { req: { job?: BuildJobId } | void; res: BuildJobState };
  "POST /api/build-job/check": { req: never; res: BuildJobState };
}
