package dev.amo.studio

private const val ContextHead = "【WorkStudio：此前聊天记录，仅作背景，不要重复执行历史任务】"
private const val ContextEnd = "【WorkStudio：此前聊天记录结束，以下是本轮用户消息】"

/** Display current input separately from its explicitly carried WorkStudio-only transcript. */
internal fun splitCarriedContext(input: String): Pair<String, JSONObject?> {
    val roleHead = "【AMO：你的任务有变化】"
    val roleAt = if (input.startsWith(roleHead + "\n")) 0 else input.lastIndexOf("\n\n" + roleHead + "\n")
    val text = if (roleAt >= 0) input.take(roleAt) else input
    if (!text.startsWith(ContextHead + "\n")) return text to null
    val end = text.indexOf("\n" + ContextEnd + "\n\n")
    if (end < 0) return text to null
    val context = runCatching { JSONObject(text.substring(ContextHead.length + 1, end)) }.getOrNull() ?: return text to null
    val messages = context.objects("messages")
    if (messages.size > 200 || messages.sumOf { it.str("text").length } > 60000 || messages.any { it.str("role") !in listOf("user", "assistant") }) return text to null
    return text.substring(end + ContextEnd.length + 3) to context
}
