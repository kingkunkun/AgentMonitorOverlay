package dev.amo.studio

import java.nio.file.Files
import okio.FileSystem
import okio.Path.Companion.toPath
import kotlin.test.*

class HistoryPrivacyTest {
    @Test fun archiveDeletesCachedContentsAndLateResponsesCannotRestoreThem() {
        val root = Files.createTempDirectory("workstudio-cache-test").toString().toPath()
        val fs = FileSystem.SYSTEM
        try {
            val account = Account("http://fixture.invalid", "owner", "test-key")
            val cache = HistoryCache(fs, root, account)
            fun manifest(revision: Int, archived: Boolean = false) = JSONObject().put("version", 3).put("revision", revision).put("tasks", JSONArray(listOf(JSONObject().put("account", "a").put("device", "d").put("id", "t")))).put("snapshots", JSONObject().put("a/d/t", JSONObject().put("task", JSONObject().put("id", "t").apply { if (archived) put("archivedAt", "now") }).put("sessions", JSONArray(listOf(JSONObject().put("id", "s"))))))
            cache.saveTasks(manifest(1)); cache.saveSession("a/d/s", listOf(JSONObject().put("text", "private-chat")))
            assertEquals(1, cache.loadSession("a/d/s").size)
            cache.saveTasks(manifest(2, true)); cache.saveTasks(manifest(1)); cache.saveSession("a/d/s", listOf(JSONObject().put("text", "late")))
            assertTrue(cache.loadSession("a/d/s").isEmpty())
            val dir = root / HistoryCache.sha("${account.server}\n${account.name}")
            assertTrue(fs.list(dir / "sessions").isEmpty())
            assertTrue(cache.loadTasks()!!.objects("tasks").isEmpty())
            // Upgrade purges only legacy chat caches; credentials/drafts have separate storage.
            fs.write(root / "account-sentinel") { writeUtf8("encrypted-account") }
            fs.write(dir / "tasks.json") { writeUtf8(manifest(3).put("version", 2).toString()) }
            fs.write(dir / "sessions" / "legacy.json") { writeUtf8("old-private-chat") }
            assertTrue(cache.loadTasks()!!.objects("tasks").isEmpty())
            assertTrue(fs.list(dir / "sessions").isEmpty())
            assertEquals("encrypted-account", fs.read(root / "account-sentinel") { readUtf8() })
        } finally { fs.deleteRecursively(root) }
    }
}
