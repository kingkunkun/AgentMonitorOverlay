package dev.amo.studio

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable internal fun DraftTranslate(repo: StudioRepository, peer: Peer?, draft: String, enabled: Boolean, replace: (String) -> Unit) {
    if (peer == null || draft.isBlank()) return
    var undo by remember(peer.identity) { mutableStateOf<Pair<String, String>?>(null) }
    LaunchedEffect(draft, enabled) { if (!enabled || undo?.second != draft) undo = null }
    // Leaving this draft, editing it, or sending it cancels this UI's wait and invalidates undo.
    key(peer.identity, draft, enabled) {
        val scope = rememberCoroutineScope()
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf("") }
        val last = undo?.takeIf { it.second == draft }
        Column {
            TextButton(enabled = enabled && !busy, onClick = {
                if (last != null) { undo = null; replace(last.first) }
                else if (!busy) { busy = true; error = ""; scope.launch {
                    try { val translated = repo.translate(peer, draft, "en"); undo = draft to translated; replace(translated) }
                    catch (e: CancellationException) { throw e }
                    catch (e: Exception) { error = e.message ?: "翻译失败，请重试" }
                    finally { busy = false }
                } }
            }) { Text(if (busy) "翻译中…" else if (last != null) "撤销翻译" else "译成英文") }
            if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Long-press in the original to narrow the passage. No clipboard read, and no chat turn. */
@Composable internal fun PassageTranslate(repo: StudioRepository, peer: Peer?, source: String) {
    if (peer?.online != true || source.isBlank()) return
    var open by remember { mutableStateOf(false) }
    TextButton(onClick = { open = true }) { Text("选段翻译", style = MaterialTheme.typography.labelSmall) }
    if (!open) return
    var original by remember { mutableStateOf(TextFieldValue(source)) }
    val selection = original.selection
    val passage = if (selection.collapsed) source else source.substring(selection.min, selection.max)
    var target by remember(passage) { mutableStateOf(if (passage.any { it in '\u3400'..'\u9fff' }) "en" else "zh") }
    var busy by remember(passage, target) { mutableStateOf(false) }
    var result by remember(passage, target) { mutableStateOf("") }
    val scope = key(passage, target, peer.identity) { rememberCoroutineScope() }
    AlertDialog(onDismissRequest = { open = false }, title = { Text("选段翻译") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(original, { original = it }, readOnly = true, label = { Text("原文（长按选择片段）") }, maxLines = 6)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                listOf("zh" to "中文", "en" to "英文").forEach { (id, label) -> FilterChip(selected = target == id, onClick = { target = id }, label = { Text(label) }) }
            }
            if (result.isNotBlank()) SelectionContainer { Text(result) }
        }
    }, confirmButton = { TextButton(enabled = !busy, onClick = {
        if (!busy) {
            busy = true
            scope.launch {
                try { result = repo.translate(peer, passage, target) }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) { result = e.message ?: "翻译失败，请重试" }
                finally { busy = false }
            }
        }
    }) { Text(if (busy) "翻译中…" else if (selection.collapsed) "翻译全文" else "翻译选段") } },
        dismissButton = { TextButton(onClick = { open = false }) { Text("关闭") } })
}
