package dev.amo.studio

/** Phone protocol has no device-file upload, native bridge or remotely executable command. */
internal object PhonePrivacy {
    private val commands = setOf("rt.list", "rt.task", "rt.items", "rt.catalog", "rt.create", "rt.start", "rt.send", "rt.approve", "rt.answer", "rt.interrupt", "rt.file", "rt.rename", "rt.task-archive", "rt.presets", "rt.people", "rt.choices", "rt.options", "rt.continue")
    fun requireCommand(kind: String, body: JSONObject) {
        require(kind in commands) { "手机隐私规则禁止此命令" }
        require(!body.has("uploads") || body.isNull("uploads") || body.optJSONArray("uploads")?.length() == 0) { "手机端不支持上传设备文件" }
    }
}

internal fun archivedRow(row: JSONObject): Boolean = !row.isNull("archivedAt") || row.str("writer") == "archived" || row.optBoolean("archived")

/** Scrub old-server snapshots too, before they enter visible state or private disk caches. */
internal fun activePhoneSnapshot(value: JSONObject): JSONObject? {
    val task = value.optJSONObject("task") ?: return null
    if (archivedRow(task)) return null
    val original = value.objects("sessions")
    val live = original.filterNot(::archivedRow)
    if (original.isNotEmpty() && live.isEmpty()) return null
    val copy = JSONObject(value.toString()).put("sessions", JSONArray(live))
    val ids = live.map { it.str("id") }.toSet()
    copy.optJSONObject("sessionProjects")?.let { projects -> projects.keys().asSequence().toList().filterNot { it in ids }.forEach { projects.remove(it) } }
    return copy
}

internal fun activePhoneCache(root: JSONObject): JSONObject {
    val snapshots = JSONObject()
    val tasks = root.objects("tasks").mapNotNull { row ->
        if (row.optBoolean("revoked")) return@mapNotNull null
        val key = "${row.str("account")}/${row.str("device")}/${row.str("id")}"
        val snapshot = root.optJSONObject("snapshots")?.optJSONObject(key)?.let(::activePhoneSnapshot) ?: return@mapNotNull null
        snapshots.put(key, snapshot); row
    }
    return JSONObject().put("version", 3).put("revision", root.optLong("revision")).put("tasks", JSONArray(tasks)).put("snapshots", snapshots)
}

internal fun activeSessionKeys(root: JSONObject): Set<String> = root.optJSONObject("snapshots")?.let { snapshots -> snapshots.keys().asSequence().flatMap { key ->
    val peer = key.substringBeforeLast('/')
    snapshots.optJSONObject(key)?.objects("sessions").orEmpty().filterNot(::archivedRow).map { "$peer/${it.str("id")}" }.asSequence()
}.toSet() } ?: emptySet()
