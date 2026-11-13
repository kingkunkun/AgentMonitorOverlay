import { z } from "zod";
import { write, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

export function companyTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "company_group_read", title: "读取公司协作群", description: "Read the company groups this bound Agent belongs to. Without roomId returns your identity, groups and their member agentIds. With roomId returns up to 100 messages, oldest first; before is a message id for older pages. Only members may read a group. Local archives and other agents' private prompts are excluded.",
      inputSchema: { roomId: z.string().optional(), before: z.string().optional(), limit: z.number().int().min(1).max(100).optional() }, readOnly: true, autoApprove: true,
      run: (args) => write(caller, (c) => typeof args.roomId === "string" ? service.company.messages(args.roomId, typeof args.before === "string" ? args.before : undefined, args.limit ?? 50, c.sessionId) : service.company.groupsFor(c.sessionId)),
    },
    {
      name: "company_message_send", title: "发送公司群消息", description: "Reply to a company group message that explicitly mentioned this bound Agent. Sender identity is fixed by your session; you cannot impersonate the CEO or another Agent. replyTo is the incoming message id. mentions contains member agentIds to assign work; [] posts a report only. Work waits behind an active turn. Use a stable clientMessageId per message to prevent duplicates; at most four automated handoffs. Do not forward local history archives.",
      inputSchema: { roomId: z.string(), text: z.string(), mentions: z.array(z.string()).optional(), replyTo: z.string(), clientMessageId: z.string() }, readOnly: false, autoApprove: true,
      run: (args) => writeAsync(caller, (c) => service.company.send(String(args.roomId), { text: args.text, mentions: args.mentions, replyTo: args.replyTo, clientMessageId: args.clientMessageId }, c.sessionId)),
    },
  ];
}
