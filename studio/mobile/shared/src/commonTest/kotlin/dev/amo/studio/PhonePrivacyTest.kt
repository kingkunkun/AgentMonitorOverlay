package dev.amo.studio

import kotlin.test.*

class PhonePrivacyTest {
    private fun snapshot() = JSONObject("""{"task":{"id":"t"},"sessions":[{"id":"live"},{"id":"archived","archivedAt":"2026-11-11"},{"id":"writer-old","writer":"archived"}],"sessionProjects":{"live":"project","archived":"private","writer-old":"private"}}""")

    @Test fun archivedTasksAndSessionsNeverEnterPhoneState() {
        val value = activePhoneSnapshot(snapshot())!!
        assertEquals(listOf("live"), value.objects("sessions").map { it.str("id") })
        assertEquals(listOf("live"), value.optJSONObject("sessionProjects")!!.keys().asSequence().toList())
        assertNull(activePhoneSnapshot(snapshot().apply { optJSONObject("task")!!.put("archivedAt", "now") }))
        assertNull(activePhoneSnapshot(snapshot().put("sessions", JSONArray(listOf(JSONObject().put("id", "x").put("writer", "archived"))))))
    }

    @Test fun revokedSnapshotsAndOldHistoryKeysAreRemoved() {
        val root = JSONObject().put("revision", 9).put("tasks", JSONArray(listOf(
            JSONObject().put("id", "t").put("account", "a").put("device", "d"),
            JSONObject().put("id", "revoked").put("account", "a").put("device", "d").put("revoked", true)
        ))).put("snapshots", JSONObject().put("a/d/t", snapshot()).put("a/d/revoked", snapshot()))
        val clean = activePhoneCache(root)
        assertEquals(1, clean.objects("tasks").size)
        assertEquals(setOf("a/d/live"), activeSessionKeys(clean))
        assertFalse(clean.toString().contains("private"))
        assertEquals(9, clean.optLong("revision"))
    }

    @Test fun noUploadOrArbitraryRemoteCommandsEvenWithFullAccess() {
        PhonePrivacy.requireCommand("rt.send", JSONObject().put("uploads", JSONArray()).put("permission", "full-auto"))
        for (kind in listOf("rt.upload", "clipboard.read", "shell", "contacts", "rt.native-history")) assertFailsWith<IllegalArgumentException> { PhonePrivacy.requireCommand(kind, JSONObject()) }
        for (uploads in listOf<Any>(JSONArray(listOf(JSONObject().put("path", "/private"))), "file", JSONObject())) assertFailsWith<IllegalArgumentException> { PhonePrivacy.requireCommand("rt.send", JSONObject().put("uploads", uploads)) }
    }

    @Test fun htmlCannotExecuteScriptsOrContactAThirdParty() {
        val page = isolatedHtml("<script>fetch('https://evil.invalid')</script>")
        for (rule in listOf("script-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'")) assertTrue(page.contains(rule), rule)
    }
}
