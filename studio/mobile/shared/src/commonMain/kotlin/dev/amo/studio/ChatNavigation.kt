package dev.amo.studio

import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal fun latestChat(task: RemoteTask): RemoteSession? = task.sessions.filter { !it.archived && it.kind != "sub" }.maxByOrNull { it.updatedAt }

/** 待处理是目录之外的虚拟位置：把所有等你审批、回答或查看的会话收在一起（2026-11-13）。 */
internal const val PendingFolder = "@pending"

/** 聊天所属的工作目录：电脑上的项目名；没有项目的归到「未指定项目」。 */
internal fun taskProject(task: RemoteTask): String = task.project?.takeIf { it.isNotBlank() } ?: "未指定项目"

/** 一个工作目录，连同它下面聊天现在的状态。 */
internal data class ChatFolder(val name: String, val tasks: List<RemoteTask>) {
    val activeAt: String = tasks.map { it.activeAt }.maxOrNull().orEmpty()
    val count: Int = tasks.size
    val running: Int = tasks.count { task -> task.sessions.any { it.state == "running" } }
    val waiting: Int = tasks.count { task -> task.sessions.any { needsYou(it.state) } }
    val tone: Tone = when {
        waiting > 0 -> Tone.Attention
        running > 0 -> Tone.Running
        else -> Tone.Quiet
    }
    /** "12 个聊天 · 2 个进行中 · 等你处理 1" */
    val summary: String = listOfNotNull(
        "$count 个聊天",
        running.takeIf { it > 0 }?.let { "$it 个进行中" },
        waiting.takeIf { it > 0 }?.let { "等你处理 $it" },
    ).joinToString(" · ")
}

/** 聊天按工作目录分组，最近有动静的目录排前面。 */
internal fun chatFolders(tasks: List<RemoteTask>): List<ChatFolder> = tasks.filterNot { it.revoked }
    .groupBy { taskProject(it) }
    .map { (name, list) -> ChatFolder(name, list.sortedByDescending { it.activeAt }) }
    .sortedByDescending { it.activeAt }

/** 电脑上等你处理的会话：等你审批、等你回答、等你看看（2026-11-13，跟 Work中转 的「待处理」对应）。 */
internal data class PendingChat(val task: RemoteTask, val session: RemoteSession)

internal fun pendingChats(tasks: List<RemoteTask>): List<PendingChat> = tasks.filterNot { it.revoked }
    .flatMap { task -> task.sessions.filter { !it.archived && (needsYou(it.state) || it.state == "awaiting-review") }.map { PendingChat(task, it) } }
    .sortedByDescending { it.session.updatedAt }

/** 待处理里的一行：会话名、目录和状态；点进去就是那个会话，处理完手机上的结果会回到电脑。 */
@Composable internal fun PendingRow(pending: PendingChat, onClick: () -> Unit) {
    val title = pending.session.title.ifBlank { pending.task.title }.ifBlank { "新聊天" }
    val subtitle = listOfNotNull(taskProject(pending.task), sessionStatusLabel(pending.session.state), "电脑离线".takeIf { !pending.task.peer.online }).joinToString(" · ")
    ListRow(title, subtitle, Tone.Attention, shortTime(pending.session.updatedAt), tag = "pending-row", onClick = onClick)
}

/**
 * 抽屉：第一层是工作目录，点进去才是这个目录的聊天（2026-11-13，跟 Codex 手机端一样的层级）。
 * 搜索始终在所有目录里找，找到就直接列出来。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ChatDrawer(state: StudioState, repo: StudioRepository, folder: String, onFolder: (String) -> Unit, select: (RemoteTask, RemoteSession?) -> Unit, home: () -> Unit, create: () -> Unit, settings: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val tasks = state.tasks.filterNot { it.revoked }
    val folders = chatFolders(tasks)
    val pendingMode = folder == PendingFolder
    val folderName = if (pendingMode) PendingFolder else folder.takeIf { name -> folders.any { it.name == name } }.orEmpty()
    val current = folders.find { it.name == folderName }
    val searching = query.isNotBlank()
    val found = tasks.filter { it.title.contains(query, true) || taskProject(it).contains(query, true) || it.project.orEmpty().contains(query, true) }.sortedByDescending { it.activeAt }
    val foundCount = found.size
    val folderCount = folders.size
    val chatCount = tasks.size
    val pending = pendingChats(tasks)
    val pendingCount = pending.size
    val chats = (current?.tasks ?: tasks).sortedWith(compareByDescending<RemoteTask> { it.key in state.pinnedTasks }.thenByDescending { it.activeAt })
    val title = when {
        searching -> "搜索"
        pendingMode -> "待处理"
        folderName.isNotBlank() -> folderName
        else -> "WorkStudio"
    }
    ModalDrawerSheet(modifier = Modifier.fillMaxHeight().widthIn(max = 340.dp).testTag("chat-drawer"), drawerContainerColor = MaterialTheme.colorScheme.surfaceVariant) {
        Row(Modifier.fillMaxWidth().padding(start = if (folderName.isNotBlank()) 4.dp else 16.dp, end = 8.dp, top = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (folderName.isNotBlank()) IconAction(AmoIcons.Back, "全部目录", "drawer-back") { onFolder("") }
            Text(title, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            IconAction(AmoIcons.Edit, "新聊天", "drawer-new-chat", enabled = state.connected && state.selectedPeer?.online == true, onClick = create)
        }
        OutlinedTextField(query, { query = it }, placeholder = { Text("搜索聊天") }, leadingIcon = { Icon(AmoIcons.Search, null, modifier = Modifier.size(18.dp)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("drawer-search"), shape = MaterialTheme.shapes.large)
        if (folderName.isBlank()) ListRow("全部目录", "$folderCount 个目录 · $chatCount 个聊天", tag = "drawer-home", onClick = home)
        if (folderName.isBlank()) ListRow("待处理", if (pendingCount > 0) "$pendingCount 个等你处理" else "没有等你的", if (pendingCount > 0) Tone.Attention else null, tag = "drawer-pending", onClick = { onFolder(PendingFolder) })
        LazyColumn(Modifier.weight(1f).testTag("drawer-chats"), contentPadding = PaddingValues(bottom = 16.dp)) {
            when {
                searching -> {
                    item("found") { SectionHeader(if (found.isEmpty()) "没有匹配的聊天" else "找到 $foundCount 个聊天") }
                    items(found, key = { it.key }) { task -> DrawerChat(task, state, select, subtitle = taskProject(task)) }
                }
                pendingMode -> {
                    item("pending-head") { SectionHeader("等你处理", trailing = { Text("$pendingCount 个", style = MaterialTheme.typography.labelSmall, color = LocalAmoColors.current.dim) }) }
                    items(pending, key = { "pending-" + it.session.id }) { p -> PendingRow(p) { select(p.task, p.session) } }
                    if (pending.isEmpty()) item("none") { Text("现在没有等你处理的会话。", modifier = Modifier.padding(20.dp), color = LocalAmoColors.current.dim) }
                }
                folderName.isBlank() -> {
                    val pinned = chats.filter { it.key in state.pinnedTasks }
                    if (pinned.isNotEmpty()) {
                        item("pins") { SectionHeader("置顶") }
                        items(pinned, key = { "p-" + it.key }) { task -> DrawerChat(task, state, select, subtitle = taskProject(task)) }
                    }
                    item("folders") { SectionHeader("工作目录") }
                    items(folders, key = { "folder-" + it.name }) { f -> FolderRow(f) { onFolder(f.name) } }
                    if (folders.isEmpty()) item("none") { Text("还没有聊天", modifier = Modifier.padding(20.dp), color = LocalAmoColors.current.dim) }
                }
                else -> {
                    item("folder-head") { SectionHeader(folderName, trailing = { Text(current?.summary.orEmpty(), style = MaterialTheme.typography.labelSmall, color = LocalAmoColors.current.dim, maxLines = 1) }) }
                    items(chats, key = { it.key }) { task -> DrawerChat(task, state, select) }
                    if (chats.isEmpty()) item("none") { Text("这个目录还没有聊天", modifier = Modifier.padding(20.dp), color = LocalAmoColors.current.dim) }
                }
            }
        }
        HorizontalDivider(color = LocalAmoColors.current.line)
        ListRow(state.account?.name ?: "账号", if (state.connected) "已连接 · 设置与隐私" else "离线 · 设置与隐私", tag = "drawer-settings", onClick = settings)
    }
}

/** 目录列表里的一行：目录名、它下面聊天在做什么、最后动过的时间。 */
@Composable internal fun FolderRow(folder: ChatFolder, onClick: () -> Unit) {
    ListRow(folder.name, folder.summary, folder.tone.takeIf { it != Tone.Quiet }, shortTime(folder.activeAt), tag = "folder-row", onClick = onClick)
}

@Composable private fun DrawerChat(task: RemoteTask, state: StudioState, select: (RemoteTask, RemoteSession?) -> Unit, subtitle: String? = null) {
    Row(Modifier.fillMaxWidth().background(if (state.selectedTask?.key == task.key) LocalAmoColors.current.selected else MaterialTheme.colorScheme.surfaceVariant).clickable { select(task, latestChat(task)) }.padding(horizontal = 20.dp, vertical = 13.dp).testTag("drawer-chat"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(task.title.ifBlank { "新聊天" }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
            if (!subtitle.isNullOrBlank()) Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = LocalAmoColors.current.dim)
        }
        val running = task.sessions.any { it.state == "running" }
        if (running) {
            Spacer(Modifier.width(8.dp)); StatusDot(Tone.Running, animate = true)
        } else if (task.sessions.any { needsYou(it.state) }) {
            Spacer(Modifier.width(8.dp)); StatusDot(Tone.Attention)
        }
    }
}
