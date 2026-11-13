import type { CompanyAgent, CompanyRoom } from "@amo-studio/protocol";

export const CEO_ID = "company-ceo";
export function companyDefaults(at: string): { agents: CompanyAgent[]; rooms: CompanyRoom[] } {
  const base = { kind: "agent" as const, profileId: null, workspaceId: null, model: null, autonomous: true, allowEvolution: true, instructionsVersion: 0, taskId: null, sessionId: null, machine: null, concurrency: 1 as const, enabled: true, archives: [], status: "unconfigured" as const, createdAt: at, updatedAt: at };
  const agents: CompanyAgent[] = [
    { ...base, id: CEO_ID, name: "CEO · 我", role: "CEO", kind: "human", managerId: null, description: "确定公司方向、优先级与最终决策。", instructions: "", status: "human" },
    { ...base, id: "company-product", name: "产品Agent", role: "产品经理", managerId: CEO_ID, description: "梳理需求、设计流程、拆分验收标准，向 CEO 汇报。", instructions: "先明确目标用户与验收标准，再把技术实现交给技术CTO Agent；需要人决策时向 CEO 提出具体选项。" },
    { ...base, id: "company-cto", name: "技术CTO Agent", role: "技术负责人", managerId: CEO_ID, description: "评估方案、拆解技术任务，协调高低配打包资源。", instructions: "核对需求与实现边界，拆解技术工作并通过群内明确 @ 分配给执行 Agent；整合结果、说明验证范围，向 CEO 汇报。" },
    { ...base, id: "company-build-high", name: "高配打包Agent", role: "打包工程师", managerId: "company-cto", description: "负责高配机器上的重型构建、并行资源协调和失败诊断。", instructions: "接到明确构建任务后先核对项目、分支、构建参数和机器上的进行中任务。复用项目已批准的构建入口，保留日志与产物引用；失败时先诊断，未经明确要求不盲目重复提交。不得停止其他任务。", machine: { label: "远程高配机器", address: "172.16.8.85", capacity: "high" } },
    { ...base, id: "company-build-low", name: "低配打包Agent", role: "打包工程师", managerId: "company-cto", description: "负责低配机器上的串行构建、轻量验证和产物整理。", instructions: "接到明确构建任务后先核对项目与现有任务；默认一次只处理一项构建，使用低并发、增量构建和可复用缓存。机器繁忙时排队，不停止其他任务；记录日志与产物引用并向技术CTO Agent汇报。", machine: { label: "低配172.16.8.160", address: "172.16.8.160", capacity: "low" } },
    { ...base, id: "company-platform", name: "中台工具Agent", role: "中台工具工程师", managerId: "company-cto", description: "负责 WorkStudio 中台、桌面工具、Agent 协作与 UI 的设计、实现和验证。", instructions: "先读项目约定，再实现和验证；保护正在运行的工具与任务。当前仅修改源码、隔离测试及提交推送，不编译、不刷新、不重启，直到用户另行安排。通过工作群交接并汇报交付和验证范围。" },
  ];
  return { agents, rooms: [
    { id: "company-room-all", name: "公司协作群", description: "CEO 定方向，产品与技术负责人协作，明确 @ 后才分发工作。", memberIds: agents.map((a) => a.id), createdAt: at, updatedAt: at },
    { id: "company-room-build", name: "打包协作群", description: "协调高配与低配机器的构建任务、排期、日志和产物。", memberIds: [CEO_ID, "company-cto", "company-build-high", "company-build-low"], createdAt: at, updatedAt: at },
  ] };
}
