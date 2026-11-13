package dev.amo.studio

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.backhandler.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// Chat-first navigation: a task opens its latest live main chat directly. The drawer holds projects/search/settings;
// the branch browser is an explicit chat-menu action, not an intermediate step required for every chat.

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StudioUi(state: StudioState, repo: StudioRepository) {
    val stack = rememberSaveable(saver = listSaver(save = { it.toList() }, restore = { it.toMutableStateList() })) { mutableStateListOf("home") }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val drawerScope = rememberCoroutineScope()
    fun closeDrawer() { drawerScope.launch { drawer.close() } }
    fun openDrawer() { drawerScope.launch { drawer.open() } }
    var sheet by rememberSaveable { mutableStateOf("") }
    // 目录优先（2026-11-13）：工作台和抽屉共用这一层目录，回到工作台还停在原目录。
    var folder by rememberSaveable { mutableStateOf("") }
    var handledSession by rememberSaveable { mutableStateOf(state.selectedSession?.id) }
    var resumed by rememberSaveable { mutableStateOf(false) }
    fun go(page: String) { if (stack.lastOrNull() != page) stack.add(page) }
    fun reset(vararg pages: String) { stack.clear(); stack.addAll(pages) }
    LaunchedEffect(state.selectedSession?.id) {
        val id = state.selectedSession?.id
        if (id != null && id != handledSession) { sheet = ""; if (stack.lastOrNull() != "chat") { reset("home", "task", "chat") } }
        handledSession = id
    }
    LaunchedEffect(state.account?.name) { if (state.account == null) { reset("home"); sheet = ""; folder = ""; resumed = false } }
    // Back to the last conversation once the phone's copy of the tasks is there.
    LaunchedEffect(state.account?.name, state.tasks.isNotEmpty()) {
        if (resumed || state.account == null || state.tasks.isEmpty()) return@LaunchedEffect
        resumed = true
        // Only while still on 工作台: someone who already went elsewhere is not pulled away.
        if (!state.resumeLast || state.selectedSession != null || stack.size > 1 || sheet.isNotEmpty()) return@LaunchedEffect
        val (peer, taskId, sessionId) = repo.lastLocation() ?: return@LaunchedEffect
        val task = state.tasks.find { it.peer.identity == peer && it.id == taskId } ?: return@LaunchedEffect
        repo.selectTask(task)
        task.sessions.find { it.id == sessionId }?.let(repo::selectSession) ?: reset("home", "task")
    }
    val message by rememberUpdatedState(state.message)
    LaunchedEffect(state.message) {
        val m = state.message ?: return@LaunchedEffect
        // Plain news goes away by itself; anything about an unconfirmed result or the login stays until closed.
        if (listOf("未确认", "失效", "替换", "重试").none { m.contains(it) }) { delay(8000); if (message == m) repo.clearMessage() }
    }
    val page = stack.lastOrNull() ?: "home"
    fun back() {
        when {
            drawer.isOpen -> closeDrawer()
            state.file != null || state.fileLoading != null -> repo.closeFile()
            sheet.isNotEmpty() -> sheet = ""
            stack.size > 1 -> { val left = stack.removeAt(stack.lastIndex); if (left == "task") repo.leaveTask() }
        }
    }
    @OptIn(ExperimentalComposeUiApi::class)
    BackHandler(drawer.isOpen || state.file != null || state.fileLoading != null || sheet.isNotEmpty() || stack.size > 1) { back() }
    ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = state.account != null, drawerContent = { if (state.account != null) ChatDrawer(state, repo, folder = folder, onFolder = { folder = it }, select = { task, session -> closeDrawer(); repo.selectTask(task); (session ?: latestChat(task))?.let { repo.selectSession(it) } ?: reset("home", "task") }, home = { closeDrawer(); repo.leaveTask(); folder = ""; reset("home") }, create = { closeDrawer(); sheet = "task" }, settings = { closeDrawer(); go("settings") }) }) {
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.fillMaxSize()) {
                when {
                    state.account == null -> Login(state, repo)
                    state.file != null -> { TopBar(state.file.name, state.file.path.takeIf { it != state.file.name }, back = repo::closeFile); Box(Modifier.weight(1f)) { FileViewer(state.file) { repo.openFile(it) } } }
                    page == "settings" -> Settings(state, repo) { back() }
                    page == "chat" && state.selectedSession != null -> ChatScreen(state, repo, back = { openDrawer() }, newSession = { sheet = "session" }, openTask = { back() })
                    (page == "task" || page == "chat") && state.selectedTask != null -> TaskPage(state, repo, back = { stack.clear(); stack.add("home"); repo.leaveTask() }) { sheet = "session" }
                    else -> Home(state, repo, folder = folder, onFolder = { folder = it }, drawer = { openDrawer() }, create = { sheet = "task" }, open = { task, session -> repo.selectTask(task); (session ?: latestChat(task))?.let { repo.selectSession(it) } ?: go("task") })
                }
            }
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp).align(Alignment.TopCenter))
            Column(Modifier.align(Alignment.BottomCenter).padding(bottom = if (page == "chat") 76.dp else 84.dp)) {
                if (state.account != null && !state.connected) Notice(if (state.connecting) "正在连接你的电脑…" else "连接断了 · 草稿留在手机上", if (state.connecting) Tone.Quiet else Tone.Attention, if (state.connecting) null else "重连", repo::retry, tag = "connection")
                state.fileLoading?.let { path -> Notice("正在读取 ${path.replace('\\', '/').substringAfterLast('/')}", Tone.Quiet, "取消", repo::closeFile, tag = "file-loading") }
                state.message?.let { Notice(it, Tone.Attention, onClose = repo::clearMessage, tag = "message") }
            }
        }
    }
    }
    if (sheet.isNotEmpty() && state.account != null) CreateSheet(state, repo, sheet == "task") { sheet = "" }
    LaunchedEffect(state.message) { if (state.message == "已提交，等待电脑确认") sheet = "" }
}

// ---- 工作台

private fun taskTone(t: RemoteTask): Tone {
    if (t.revoked) return Tone.Quiet
    val live = t.sessions.filterNot { it.archived }
    return when {
        live.any { needsYou(it.state) || it.state == "awaiting-review" } -> Tone.Attention
        live.any { it.state == "running" } -> Tone.Running
        live.maxByOrNull { it.updatedAt }?.state == "error" -> Tone.Error
        else -> Tone.Quiet
    }
}

/** 工作台：第一层是工作目录，点进去看这个目录的聊天（2026-11-13，按 Codex 手机端的层级）。 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable private fun Home(state: StudioState, repo: StudioRepository, folder: String, onFolder: (String) -> Unit, drawer: () -> Unit, create: () -> Unit, open: (RemoteTask, RemoteSession?) -> Unit) {
    val computers = state.peers.filter { it.role == "guest" }
    var query by rememberSaveable { mutableStateOf("") }
    var menuTask by remember { mutableStateOf<String?>(null) }
    var rename by remember { mutableStateOf<RemoteTask?>(null) }
    var renameText by remember { mutableStateOf("") }
    var archiving by remember { mutableStateOf<RemoteTask?>(null) }
    val searching = query.isNotBlank()
    val folders = chatFolders(state.tasks)
    val pendingMode = folder == PendingFolder
    val pending = pendingChats(state.tasks)
    val current = folders.find { it.name == folder }
    val insideFolder = !searching && (current != null || pendingMode)
    val shown = (when {
        searching -> state.tasks.filterNot { it.revoked }.filter { it.title.contains(query, true) || taskProject(it).contains(query, true) || it.project.orEmpty().contains(query, true) }
        current != null -> current.tasks
        else -> emptyList()
    }).sortedWith(compareByDescending<RemoteTask> { it.key in state.pinnedTasks }.thenByDescending { it.activeAt })
    val shownCount = shown.size
    val subtitle = when { state.connecting -> "正在连接…"; !state.connected -> "离线 · 草稿已保留"; computers.isEmpty() -> "连接你的电脑"; else -> state.selectedPeer?.name ?: "已连接" }
    BackHandler(insideFolder) { onFolder("") }
    Column(Modifier.fillMaxSize()) {
        if (pendingMode && insideFolder) TopBar("待处理", if (pending.isEmpty()) "都处理完了" else "${pending.size} 个会话等你审批或回答", back = { onFolder("") }) { IconAction(AmoIcons.Refresh, "刷新", "refresh", enabled = state.connected) { repo.refresh(force = true) } }
        else if (current != null && insideFolder) TopBar(current.name, current.summary, back = { onFolder("") }) { IconAction(AmoIcons.Refresh, "刷新", "refresh", enabled = state.connected) { repo.refresh(force = true) } }
        else TopBar("WorkStudio", subtitle, back = drawer, navigationIcon = AmoIcons.Menu, navigationLabel = "聊天列表") { IconAction(AmoIcons.Edit, "新聊天", "task-create", enabled = state.connected && state.selectedPeer?.online == true, onClick = create) }
        OutlinedTextField(query, { query = it }, placeholder = { Text(if (current != null) "在这个目录里搜" else "搜索聊天") }, leadingIcon = { Icon(AmoIcons.Search, null, modifier = Modifier.size(18.dp)) }, singleLine = true, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp).testTag("chat-search"))
        LazyColumn(Modifier.weight(1f).testTag("tasks"), contentPadding = PaddingValues(bottom = 24.dp)) {
            if (!insideFolder && !searching) {
                if (pending.isNotEmpty()) {
                    item("pending") { SectionHeader("待处理") { Text("${pending.size} 个等你处理", style = MaterialTheme.typography.labelSmall, color = LocalAmoColors.current.dim) } }
                    items(pending, key = { "pending-" + it.session.id }) { p -> PendingRow(p) { open(p.task, p.session) } }
                }
                if (computers.isEmpty()) item("pair") { SectionHeader("连接电脑"); Text("使用电脑手机远程里创建的账号登录，并选择你的电脑。", style = MaterialTheme.typography.bodySmall, color = LocalAmoColors.current.dim, modifier = Modifier.padding(horizontal = 16.dp)); PairingList(state, repo) }
                item("folders") { SectionHeader("工作目录") { IconAction(AmoIcons.Refresh, "刷新", "refresh", enabled = state.connected) { repo.refresh(force = true) } } }
                items(folders, key = { "folder-" + it.name }) { f -> FolderRow(f) { query = ""; onFolder(f.name) } }
                if (folders.isEmpty()) item("empty") { Empty("今天想做什么？点右上角新建聊天，执行会在你的电脑上完成。") }
            } else if (pendingMode) {
                item("pending-head") { SectionHeader("等你处理") { Text("${pending.size} 个", style = MaterialTheme.typography.labelSmall, color = LocalAmoColors.current.dim) } }
                items(pending, key = { "pending-" + it.session.id }) { p -> PendingRow(p) { open(p.task, p.session) } }
                if (pending.isEmpty()) item("empty") { Empty("现在没有等你处理的会话。") }
            } else {
                item("recent") { SectionHeader(if (searching) "搜索结果" else "$shownCount 个聊天") }
                items(shown, key = { it.key }) { task ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.weight(1f)) { ListRow((if (task.key in state.pinnedTasks) "⌖ " else "") + task.title.ifBlank { "新聊天" }, listOfNotNull(if (searching) taskProject(task) else null, if (task.sessions.any { needsYou(it.state) }) "等待审批" else null, if (!task.peer.online) "电脑离线" else null).joinToString(" · "), taskTone(task).takeIf { it != Tone.Quiet }, shortTime(task.activeAt), "task-row") { open(task, null) } }
                        Box {
                            IconAction(AmoIcons.More, "聊天操作", "task-menu") { menuTask = task.key }
                            DropdownMenu(menuTask == task.key, { menuTask = null }) {
                                DropdownMenuItem(text = { Text(if (task.key in state.pinnedTasks) "取消置顶聊天" else "置顶聊天") }, onClick = { repo.pinTask(task); menuTask = null })
                                DropdownMenuItem(text = { Text("重命名聊天") }, enabled = state.connected && task.peer.online, onClick = { rename = task; renameText = task.title; menuTask = null })
                                DropdownMenuItem(text = { Text("归档聊天") }, enabled = state.connected && task.peer.online && task.peer.account == state.account?.name, onClick = { archiving = task; menuTask = null })
                            }
                        }
                    }
                }
                if (shown.isEmpty()) item("empty") { Empty(if (searching) "没有找到聊天" else "这个目录还没有聊天。") }
            }
        }
    }
    rename?.let { task -> AlertDialog(onDismissRequest = { rename = null }, title = { Text("重命名聊天") }, text = { OutlinedTextField(renameText, { renameText = it }, label = { Text("聊天名称") }, singleLine = true) }, confirmButton = { AmoTextButton(enabled = renameText.isNotBlank(), onClick = { repo.renameTask(task, renameText); rename = null }) { Text("保存") } }, dismissButton = { AmoTextButton(onClick = { rename = null }) { Text("取消") } }) }
    archiving?.let { task -> AlertDialog(onDismissRequest = { archiving = null }, title = { Text("归档聊天？") }, text = { Text("聊天在电脑保留，手机上的聊天副本会移除。正在执行的会话会停止。") }, confirmButton = { AmoTextButton(onClick = { repo.archiveTask(task); archiving = null }) { Text("归档聊天") } }, dismissButton = { AmoTextButton(onClick = { archiving = null }) { Text("取消") } }) }
}

@Composable private fun Chip(label: String, selected: Boolean, tone: Tone?, onClick: () -> Unit) {
    val c = LocalAmoColors.current
    Row(Modifier.clip(RoundedCornerShape(16.dp)).background(if (selected) c.selected else MaterialTheme.colorScheme.surface).border(1.dp, c.line, RoundedCornerShape(16.dp)).clickable(onClick = onClick).heightIn(min = 36.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        if (tone != null) { StatusDot(tone); Spacer(Modifier.width(6.dp)) }
        Text(label, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

/** Same-account devices online to pair with, and how the requests stand. */
@Composable private fun PairingList(state: StudioState, repo: StudioRepository) {
    val available = state.onlineDevices.filter { online -> state.peers.none { it.identity == online.identity } }
    Column {
        available.forEach { p -> ListRow(p.name, "点一下请求配对，然后在这台电脑上确认", Tone.Quiet, tag = "peer-available") { repo.requestPair(p.account, p.device) } }
        if (available.isEmpty()) Empty(if (state.peers.any { it.role == "guest" }) "同账号没有别的在线电脑要配对。" else "没有找到同账号在线的电脑。请确认电脑上的 WorkStudio 开着、登录的是同一个账号。")
        state.pairing.filter { it.str("state") != "allowed" }.forEach { pair -> Text(if (pair.str("state") == "refused") "配对请求被电脑拒绝了" else "配对请求已发出，等电脑确认", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) }
    }
}

// ---- a task's sessions

@Composable private fun TaskPage(state: StudioState, repo: StudioRepository, back: () -> Unit, create: () -> Unit) {
    val task = state.selectedTask ?: return
    val c = LocalAmoColors.current
    val open = rememberSaveable(task.key, saver = listSaver(save = { it.toList() }, restore = { it.toMutableStateList() })) { mutableStateListOf<String>() }
    var descriptionOpen by rememberSaveable(task.key) { mutableStateOf(false) }
    val live = state.sessions.filterNot { it.archived }
    val ids = live.map { it.id }.toSet()
    val children = live.filter { it.parentId != null && it.parentId in ids }.groupBy { it.parentId!! }
    val roots = live.filter { it.parentId == null || it.parentId !in ids }.sortedByDescending { it.updatedAt }
    fun model(s: RemoteSession) = state.profiles.find { it.first == s.profileId }?.second
    val subtitle = listOfNotNull(task.peer.name + if (task.peer.online) "" else "（离线）", task.project, "${live.size} 个会话", if (task.revoked) "授权已撤回" else null).joinToString(" · ")
    Column(Modifier.fillMaxSize()) {
        TopBar(task.title.ifBlank { "新聊天" }, subtitle, back = back) { IconAction(AmoIcons.Refresh, "刷新", enabled = state.connected) { repo.refresh(force = true) } }
        Box(Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("sessions"), contentPadding = PaddingValues(bottom = 96.dp)) {
                if (task.description.isNotBlank()) item("description") {
                    SelectionContainer { Text(task.description, style = MaterialTheme.typography.bodySmall, color = c.dim, maxLines = if (descriptionOpen) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.fillMaxWidth().clickable { descriptionOpen = !descriptionOpen }.padding(horizontal = 16.dp, vertical = 12.dp)) }
                    HorizontalDivider(color = c.line)
                }
                fun LazyListScope.branch(s: RemoteSession, depth: Int) {
                    val kids = children[s.id].orEmpty().sortedByDescending { it.updatedAt }
                    item(s.id) {
                        // Its project only where it is not the task's (that one is in the bar above; 2026-11-09).
                        val parts = listOfNotNull(sessionStatusLabel(s.state), when (s.kind) { "sub" -> "子代理"; "fork" -> "分支"; else -> null }, model(s), s.project?.takeIf { it != task.project }, if (kids.isNotEmpty()) "${kids.size} 个子会话" else null)
                        ListRow(s.title.ifBlank { "未命名会话" }, parts.joinToString(" · "), toneOf(s.state), shortTime(s.updatedAt), tag = "session-row", indent = depth.coerceAtMost(3)) { repo.selectSession(s) }
                    }
                    if (kids.isNotEmpty()) {
                        val shown = s.id in open
                        item(s.id + "-kids") {
                            Row(Modifier.fillMaxWidth().clickable { if (shown) open.remove(s.id) else open.add(s.id) }.heightIn(min = 40.dp).padding(start = 16.dp + ((depth + 1).coerceAtMost(3) * 20).dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                                Icon(if (shown) AmoIcons.ChevronDown else AmoIcons.ChevronRight, contentDescription = null, tint = c.dim, modifier = Modifier.size(16.dp))
                                Text(if (shown) "收起 ${kids.size} 个子会话" else "${kids.size} 个子会话" + (kids.count { it.state == "running" }.takeIf { it > 0 }?.let { "（$it 个在跑）" } ?: ""), style = MaterialTheme.typography.bodySmall, color = c.dim, modifier = Modifier.padding(start = 6.dp))
                            }
                        }
                        if (shown) kids.forEach { branch(it, depth + 1) }
                    }
                }
                roots.forEach { branch(it, 0) }
                if (live.isEmpty()) item("empty") { Empty("这个任务还没有会话。点右下角的「+」开一个。") }

            }
            Box(Modifier.align(Alignment.BottomEnd).padding(20.dp)) { Fab("新建会话", "session-create", state.connected && !state.busy && task.peer.online && !task.revoked, create) }
        }
    }
}

// ---- new task / new session

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun CreateSheet(state: StudioState, repo: StudioRepository, task: Boolean, close: () -> Unit) {
    var title by rememberSaveable(task) { mutableStateOf("") }
    var text by rememberSaveable(task) { mutableStateOf("") }
    var profile by rememberSaveable(task) { mutableStateOf("") }
    var project by rememberSaveable { mutableStateOf("") }
    var topic by rememberSaveable { mutableStateOf("") }
    val models = if (task) state.catalog?.objects("models").orEmpty().map { it.str("id") to it.str("label") } else state.profiles
    LaunchedEffect(models) { if (models.none { it.first == profile }) profile = models.firstOrNull()?.first ?: "" }
    val projects = state.catalog?.objects("projects").orEmpty().map { it.str("id") to it.str("name") }
    val common = state.catalog?.optBoolean("allowCommon") == true
    LaunchedEffect(projects) { if (project.isBlank() && !common) project = projects.firstOrNull()?.first ?: "" }
    val computers = state.peers.filter { it.role == "guest" && it.online }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), shape = RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 20.dp).padding(bottom = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(if (task) "新聊天" else "新会话 · ${state.selectedTask?.title ?: ""}", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (task) {
                if (computers.size > 1) Choice("电脑", computers.map { it.identity to it.name }, state.selectedPeer?.identity ?: "") { id -> computers.find { it.identity == id }?.let(repo::selectPeer) }
                Choice("项目", (if (common) listOf("" to "公共目录") else emptyList()) + projects, project) { project = it }
            }
            Choice("模型", models, profile) { profile = it }
            OutlinedTextField(text, { text = it }, label = { Text("给模型的第一条消息") }, minLines = 3, maxLines = 8, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth().testTag("create-text"))
            if (models.isEmpty()) Text("电脑还没有允许手机用的模型，请在电脑的「远程」设置里打开。", style = MaterialTheme.typography.bodySmall, color = LocalAmoColors.current.attention)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                Text(if (task) "建好后马上开始第一个会话" else "在这个任务下开一个新会话", style = MaterialTheme.typography.bodySmall, color = LocalAmoColors.current.dim, modifier = Modifier.weight(1f))
                PrimaryButton(if (state.busy) "正在提交…" else "开始", "create-submit", state.connected && !state.busy && profile.isNotEmpty() && text.isNotBlank() && (!task || common || project.isNotBlank())) {
                    if (task) repo.createTask("", text, project.ifBlank { null }, null, profile) else repo.startSession(profile, text)
                }
            }
        }
    }
}

// ---- 设置

@Composable private fun Settings(state: StudioState, repo: StudioRepository, back: () -> Unit) {
    val account = state.account ?: return
    val c = LocalAmoColors.current
    Column(Modifier.fillMaxSize()) {
        TopBar("设置", back = back)
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            SectionHeader("外观")
            listOf("codex" to "Codex（默认）", "light" to "浅色", "dark" to "深色", "system" to "跟随系统").forEach { (id, label) ->
                Row(Modifier.fillMaxWidth().clickable { repo.setTheme(id) }.heightIn(min = 48.dp).padding(horizontal = 8.dp).testTag("theme-$id"), verticalAlignment = Alignment.CenterVertically) { RadioButton(selected = state.theme == id, onClick = { repo.setTheme(id) }); Text(label) }
            }
            SectionHeader("打开应用时")
            Row(Modifier.fillMaxWidth().clickable { repo.setResumeLast(!state.resumeLast) }.heightIn(min = 56.dp).padding(horizontal = 16.dp).testTag("resume-last"), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text("回到上次的对话"); Text("关掉后每次从工作台开始", style = MaterialTheme.typography.bodySmall, color = c.dim) }
                Switch(state.resumeLast, { repo.setResumeLast(it) })
            }
            SectionHeader("电脑") { AmoTextButton(onClick = { repo.refresh(force = true) }, enabled = state.connected) { Text("刷新") } }
            state.peers.filter { it.role == "guest" }.forEach { p -> ListRow(p.name, "${if (p.online) "在线" else "离线"} · ${p.account}", if (p.online) Tone.Running else Tone.Quiet, tag = "peer-paired") { repo.selectPeer(p) } }
            Text("要配对的电脑", style = MaterialTheme.typography.labelSmall, color = c.dim, modifier = Modifier.padding(start = 16.dp, top = 12.dp))
            PairingList(state, repo)
            // iOS: TestFlight updates the app; only its version is shown.
            SectionHeader(if (repo.updatesSupported) "更新" else "版本")
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (repo.updatesSupported) UpdateSection(state.update, repo)
                else Text("当前版本 ${repo.versionName}", color = c.dim, style = MaterialTheme.typography.bodySmall)
            }
            SectionHeader("隐私与本机数据")
            Text("不读取或上传手机相册、通讯录、位置、短信、其他应用数据或剪贴板。只向你登录的服务器发送手动提交的聊天、配对信息和任务操作；手机文件上传已禁用。", modifier = Modifier.padding(horizontal = 16.dp), style = MaterialTheme.typography.bodySmall, color = c.dim)
            Text("已归档聊天不下载、不保留手机缓存。账号令牌由系统密钥加密保存在此设备；覆盖安装保留登录，卸载、清除应用数据或主动退出会删除本机登录。服务器改密或撤销账号后需重新登录。", modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp), style = MaterialTheme.typography.bodySmall, color = c.dim)
            SectionHeader("账号")
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(account.name, style = MaterialTheme.typography.titleSmall)
                Text(account.server, style = MaterialTheme.typography.bodySmall, color = c.dim)
                Text("这台手机：${state.deviceName}", style = MaterialTheme.typography.bodySmall, color = c.dim)
                SecondaryButton("退出登录", "logout", modifier = Modifier.padding(top = 6.dp)) { repo.logout() }
            }
        }
    }
}

/** 设置 → 更新 (2026-10-31): this app's version, a newer one on the server with its notes, download progress, install. */
@Composable private fun UpdateSection(u: AppUpdate, repo: StudioRepository) {
    val c = LocalAmoColors.current
    Text("当前版本 ${repo.versionName}", color = c.dim, style = MaterialTheme.typography.bodySmall)
    val latest = u.latest
    if (latest == null) SecondaryButton(if (u.checking) "正在检查…" else "检查更新", "update-check", !u.checking) { repo.checkUpdate() }
    else {
        Text("新版本 ${latest.version} · ${megabytes(latest.size)} MB", style = MaterialTheme.typography.titleSmall)
        if (latest.notes.isNotBlank()) SelectionContainer { Text(latest.notes, style = MaterialTheme.typography.bodySmall) }
        when {
            u.downloading -> {
                LinearProgressIndicator(progress = { (u.downloaded.toFloat() / latest.size).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth().testTag("update-progress"))
                Row(verticalAlignment = Alignment.CenterVertically) { Text("已下载 ${megabytes(u.downloaded)} / ${megabytes(latest.size)} MB", modifier = Modifier.weight(1f), color = c.dim, style = MaterialTheme.typography.bodySmall); AmoTextButton(onClick = repo::cancelUpdate) { Text("取消") } }
            }
            u.ready != null -> PrimaryButton("安装", "update-install") { repo.installUpdate() }
            else -> PrimaryButton("下载并安装", "update-download") { repo.downloadUpdate() }
        }
    }
    u.note?.let { Text(it, color = c.dim, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("update-note")) }
}

// ---- 登录

@Composable private fun Login(state: StudioState, repo: StudioRepository) {
    // Empty, no team server's address (2026-11-05, the user: the source is public now, people run their own relay).
    var server by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("WorkStudio", style = MaterialTheme.typography.headlineMedium)
        Text("登录电脑“手机远程”里创建的独立账号，即可查看聊天、发送任务、选择模型和审批。", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall)
        Text("登录保存在此设备并加密，覆盖安装无需重新输入；不要卸载或清除应用数据。", color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall)
        Spacer(Modifier.height(4.dp))
        Field(server, { server = it }, "服务器地址", "login-server", hint = "比如 192.168.1.20:47950")
        Field(name, { name = it }, "账号", "login-name")
        OutlinedTextField(password, { password = it }, label = { Text("密码") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, shape = MaterialTheme.shapes.small, modifier = Modifier.fillMaxWidth().testTag("login-password"))
        PrimaryButton(if (state.busy) "正在登录…" else "登录", "login-submit", !state.busy && server.isNotBlank() && name.isNotBlank() && password.isNotBlank(), Modifier.fillMaxWidth()) { repo.login(server.trim(), name.trim(), password); password = "" }
        Text("地址和账号请在电脑 WorkStudio → 合作模式 → 手机远程中查看和创建；这套账号与团队账号独立，先在互通局域网连接。",color = LocalAmoColors.current.dim, style = MaterialTheme.typography.bodySmall)
    }
}

/** "12.3": bytes as MB with one decimal. */
internal fun megabytes(bytes: Long): String = oneDecimal(bytes / 1048576.0)

/** As "%.1f".format (JVM-only) for the numbers shown here (not negative): one decimal, half up. */
internal fun oneDecimal(value: Double): String {
    val tenths = kotlin.math.floor(value * 10 + 0.5).toLong()
    return "${tenths / 10}.${tenths % 10}"
}
