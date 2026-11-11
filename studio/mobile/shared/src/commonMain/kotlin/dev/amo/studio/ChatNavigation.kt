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

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ChatDrawer(state: StudioState, repo: StudioRepository, select: (RemoteTask) -> Unit, home: () -> Unit, create: () -> Unit, settings: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val chats = state.tasks.filterNot { it.revoked }.filter { query.isBlank() || it.title.contains(query, true) || it.project.orEmpty().contains(query, true) }.sortedWith(compareByDescending<RemoteTask> { it.key in state.pinnedTasks }.thenByDescending { it.activeAt })
    ModalDrawerSheet(modifier = Modifier.fillMaxHeight().widthIn(max = 340.dp).testTag("chat-drawer"), drawerContainerColor = MaterialTheme.colorScheme.surfaceVariant) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) { Text("WorkStudio", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f)); IconAction(AmoIcons.Edit, "新聊天", "drawer-new-chat", enabled = state.connected && state.selectedPeer?.online == true, onClick = create) }
        OutlinedTextField(query, { query = it }, placeholder = { Text("搜索聊天") }, leadingIcon = { Icon(AmoIcons.Search, null, modifier = Modifier.size(18.dp)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp).testTag("drawer-search"), shape = MaterialTheme.shapes.large)
        ListRow("全部聊天", tag = "drawer-home", onClick = home)
        LazyColumn(Modifier.weight(1f).testTag("drawer-chats"), contentPadding = PaddingValues(bottom = 16.dp)) {
            chats.filter { it.key in state.pinnedTasks }.takeIf { it.isNotEmpty() }?.let { pinned -> item("pins") { SectionHeader("置顶") }; items(pinned, key = { "p-" + it.key }) { task -> DrawerChat(task, state, select) } }
            chats.filterNot { it.key in state.pinnedTasks }.groupBy { it.project ?: "未指定项目" }.forEach { (project, tasks) ->
                item("project-$project") { SectionHeader(project) }
                items(tasks, key = { it.key }) { task -> DrawerChat(task, state, select) }
            }
            if (chats.isEmpty()) item("none") { Text(if (query.isBlank()) "还没有聊天" else "没有匹配的聊天", modifier = Modifier.padding(20.dp), color = LocalAmoColors.current.dim) }
        }
        HorizontalDivider(color = LocalAmoColors.current.line)
        ListRow(state.account?.name ?: "账号", if (state.connected) "已连接 · 设置与隐私" else "离线 · 设置与隐私", tag = "drawer-settings", onClick = settings)
    }
}

@Composable private fun DrawerChat(task: RemoteTask, state: StudioState, select: (RemoteTask) -> Unit) {
    Row(Modifier.fillMaxWidth().background(if (state.selectedTask?.key == task.key) LocalAmoColors.current.selected else MaterialTheme.colorScheme.surfaceVariant).clickable { select(task) }.padding(horizontal = 20.dp, vertical = 13.dp).testTag("drawer-chat"), verticalAlignment = Alignment.CenterVertically) {
        Text(task.title.ifBlank { "新聊天" }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (task.sessions.any { it.state == "running" }) { Spacer(Modifier.width(8.dp)); StatusDot(Tone.Running) }
    }
}
