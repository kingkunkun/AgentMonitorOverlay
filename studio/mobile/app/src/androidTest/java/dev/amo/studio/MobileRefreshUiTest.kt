package dev.amo.studio

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Run only in dev.amo.studio.qa, against android-fixture. Never signs out or clears the installed user's app. */
@RunWith(AndroidJUnit4::class)
class MobileRefreshUiTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private fun exists(m: SemanticsMatcher) = compose.onAllNodes(m).fetchSemanticsNodes().isNotEmpty()
    private fun wait(m: SemanticsMatcher) { compose.waitUntil(60_000) { exists(m) } }
    private fun hideKeyboard() { compose.runOnIdle { val a = compose.activity; (a.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(a.window.decorView.windowToken, 0) }; compose.waitForIdle() }
    private fun screenshot(name: String) {
        hideKeyboard()
        val image = compose.onRoot().captureToImage().asAndroidBitmap()
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots/$name.png")
        file.parentFile!!.mkdirs(); file.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }

    @Test fun directChatDrawerOptionsAndPersistentAccount() {
        val context = instrumentation.targetContext
        assertEquals("dev.amo.studio.qa", context.packageName)
        val descriptor = instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/amo-android-test.json")
        val credentials = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { JSONObject(it.readText()) }
        wait(hasTestTag("login-server"))
        for ((tag, value) in listOf("login-server" to credentials.getString("server"), "login-name" to credentials.getString("name"), "login-password" to credentials.getString("password"))) compose.onNodeWithTag(tag).performScrollTo().performTextReplacement(value)
        hideKeyboard(); compose.onNodeWithTag("login-submit").performScrollTo().performClick()
        wait(hasTestTag("tasks"))
        compose.waitUntil(60_000) { exists(hasTestTag("peer-available")) || exists(hasTestTag("task-row")) }
        if (exists(hasTestTag("peer-available"))) compose.onAllNodesWithTag("peer-available")[0].performClick()
        wait(hasTestTag("task-row")); screenshot("mobile-home")
        compose.onNode(hasTestTag("task-row") and hasText("Android integration fixture")).performClick()
        // One tap opens the actual composer, never a session-item interstitial.
        wait(hasTestTag("chat-input")); wait(hasTestTag("chat-model") and isEnabled()); screenshot("mobile-chat")
        assertFalse(exists(hasText("上一项操作尚未完成，请等待结果")))
        compose.onNodeWithTag("chat-model").performClick(); wait(hasTestTag("select-mobile-model"))
        screenshot("mobile-model-options")
        compose.onNodeWithTag("select-mobile-model").performClick(); wait(hasTestTag("model-search")); screenshot("mobile-model-search")
        compose.onNodeWithText("取消").performClick()
        compose.onNodeWithTag("back").performClick(); wait(hasTestTag("chat-drawer")); screenshot("mobile-drawer")
        compose.onNodeWithTag("drawer-settings").performClick(); wait(hasText("隐私与本机数据")); screenshot("mobile-settings")
        val platform = AndroidPlatform(context)
        val encrypted = JSONObject(platform.prefs.string("account")!!)
        val token = platform.decrypt(encrypted.getString("token")); assertTrue(token.isNotBlank())
        // Reopening the repository preserves the exact encrypted credentials and remains signed in.
        val before = platform.prefs.string("account")
        val reopened = StudioRepository(AndroidPlatform(context))
        assertEquals(credentials.getString("name"), reopened.state.value.account?.name)
        assertEquals(before, platform.prefs.string("account")); reopened.close()
        val permissions = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty().toSet()
        assertTrue(permissions.none { it.contains("READ_") || it.contains("LOCATION") || it.contains("RECORD_AUDIO") || it.contains("CAMERA") || it.contains("CONTACT") || it.contains("ACCESSIBILITY") })
    }
}
