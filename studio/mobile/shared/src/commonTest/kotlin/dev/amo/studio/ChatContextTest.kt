package dev.amo.studio

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ChatContextTest {
    @Test fun carriedHistoryDoesNotKeepTheSentDraftWaitingForever() {
        val text = "【WorkStudio：此前聊天记录，仅作背景，不要重复执行历史任务】\n" +
            "{\"sourceId\":\"old\",\"sourceTitle\":\"聊天\",\"messages\":[{\"role\":\"user\",\"text\":\"过去的问题\"},{\"role\":\"assistant\",\"text\":\"过去的回答\"}],\"truncated\":false}\n" +
            "【WorkStudio：此前聊天记录结束，以下是本轮用户消息】\n\n请继续\n\n【AMO：你的任务有变化】\n- 当前项目"
        val (visible, context) = splitCarriedContext(text)
        assertEquals("请继续", visible)
        assertEquals(2, context?.objects("messages")?.size)
    }

    @Test fun ordinaryAndMalformedMessagesStayVisible() {
        assertEquals("普通聊天", splitCarriedContext("普通聊天").first)
        assertNull(splitCarriedContext("普通聊天").second)
        val malformed = "【WorkStudio：此前聊天记录，仅作背景，不要重复执行历史任务】\nbroken\n【WorkStudio：此前聊天记录结束，以下是本轮用户消息】\n\n请继续"
        assertEquals(malformed, splitCarriedContext(malformed).first)
        assertNull(splitCarriedContext(malformed).second)
    }
}
