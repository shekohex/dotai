package com.coder.pi

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.graphics.Rect
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

@Composable
internal fun SpeechSettingsScreen(
    tokens: UiTokens,
    onDictation: () -> Unit,
    onProviders: () -> Unit,
    onTranscription: () -> Unit,
    onEnhancement: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val speechSettings = SpeechSettingsStore.values(context)
    SettingsScaffold("Speech", tokens, onBack) {
        SettingsSection("INPUT", tokens) {
            SettingsValueRow(R.drawable.ic_feather_mic, "Dictation Input", "Sensitivity and capture feedback", "Open", tokens, chevron = true) { onDictation() }
        }
        SettingsSection("PROVIDERS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, "OpenAI-Compatible Providers", "Configure endpoint aliases and API keys", "Manage", tokens, chevron = true) { onProviders() }
        }
        SettingsSection("TASKS", tokens) {
            SettingsValueRow(R.drawable.ic_feather_message_circle, "Transcription", "${speechSettings.realtimeTranscriptionModel} · ${speechSettings.realtimeTranscriptionLanguage}", "Configure", tokens, chevron = true) { onTranscription() }
            SettingsValueRow(R.drawable.ic_feather_edit_3, "Enhancement", "${if (speechSettings.enhancementEnabled) "On" else "Off"} · ${speechSettings.enhancementModel}", "Configure", tokens, chevron = true) { onEnhancement() }
        }
        item { Text("Dictation uses configured OpenAI-compatible Realtime API. On-device speech-to-text is not used.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
internal fun SpeechDictationSettingsScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    var speechSettings by remember { mutableStateOf(SpeechSettingsStore.values(context)) }
    SettingsScaffold("Dictation Input", tokens, onBack) {
        SettingsSection("VOICE DETECTION", tokens) {
            SettingsValueRow(R.drawable.ic_feather_sliders, "Voice Sensitivity", speechSettings.vadSensitivityLabel(), "+", tokens) {
                SpeechSettingsStore.setVadSensitivity(context, (speechSettings.vadSensitivity + 1) % 5)
                speechSettings = SpeechSettingsStore.values(context)
            }
        }
        SettingsSection("FEEDBACK", tokens) {
            SettingsValueRow(R.drawable.ic_feather_sliders, "Enhancement Haptic", "Tap to cycle and preview", TerminalHapticPatterns.option(speechSettings.enhancementHapticPattern).label, tokens) {
                val next = TerminalHapticPatterns.next(speechSettings.enhancementHapticPattern)
                SpeechSettingsStore.setEnhancementHapticPattern(context, next.id)
                context.performSpeechEnhancementHaptic(next.id)
                speechSettings = SpeechSettingsStore.values(context)
            }
        }
    }
}

@Composable
internal fun SpeechTranscriptionTaskSettingsScreen(
    tokens: UiTokens,
    onProvider: () -> Unit,
    onModels: () -> Unit,
    onLanguage: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val speechSettings = SpeechSettingsStore.values(context)
    val providers = SpeechSettingsStore.providers(context)
    val selectedProvider = providers.providerForTask(OpenAiProviderTask.Transcription, speechSettings.realtimeTranscriptionProviderId)
    SettingsScaffold("Transcription", tokens, onBack) {
        SettingsSection("MODEL", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, "Provider", selectedProvider?.name ?: "Select provider", "Select", tokens, chevron = true) { onProvider() }
            SettingsValueRow(R.drawable.ic_feather_cpu, "Model", speechSettings.realtimeTranscriptionModel, "Select", tokens, chevron = true) { onModels() }
            SettingsValueRow(R.drawable.ic_feather_book, "Language", speechLanguageLabel(speechSettings.realtimeTranscriptionLanguage), "Select", tokens, chevron = true) { onLanguage() }
        }
    }
}

@Composable
internal fun SpeechEnhancementTaskSettingsScreen(
    tokens: UiTokens,
    onProvider: () -> Unit,
    onModels: () -> Unit,
    onVocabulary: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    var speechSettings by remember { mutableStateOf(SpeechSettingsStore.values(context)) }
    val selectedProvider = SpeechSettingsStore.providers(context).providerForTask(OpenAiProviderTask.Enhancement, speechSettings.enhancementProviderId)
    var promptDialogOpen by remember { mutableStateOf(false) }
    val defaultPrompt = remember(context) { SpeechSettingsStore.defaultPrompt(context) }
    SettingsScaffold("Enhancement", tokens, onBack) {
        SettingsSection("MODEL", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_message_circle, "Enhance Transcript", speechSettings.enhancementEnabled, tokens) {
                SpeechSettingsStore.setEnhancementEnabled(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsToggleRow(R.drawable.ic_feather_send, "Auto Submit After Enhancement", speechSettings.autoSubmitAfterEnhancement, tokens) {
                SpeechSettingsStore.setAutoSubmitAfterEnhancement(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_server, "Provider", selectedProvider?.name ?: "Select provider", "Select", tokens, chevron = true) { onProvider() }
            SettingsValueRow(R.drawable.ic_feather_cpu, "Model", speechSettings.enhancementModel, "Select", tokens, chevron = true) { onModels() }
            SettingsSecondsStepperRow(R.drawable.ic_feather_clock, "Timeout", speechSettings.enhancementTimeoutSeconds, tokens, {
                SpeechSettingsStore.setEnhancementTimeoutSeconds(context, speechSettings.enhancementTimeoutSeconds - 5)
                speechSettings = SpeechSettingsStore.values(context)
            }, {
                SpeechSettingsStore.setEnhancementTimeoutSeconds(context, speechSettings.enhancementTimeoutSeconds + 5)
                speechSettings = SpeechSettingsStore.values(context)
            })
        }
        SettingsSection("CONTEXT", tokens) {
            SettingsToggleRow(R.drawable.ic_feather_terminal, "Visible Terminal Context", speechSettings.includeVisibleTerminalContext, tokens) {
                SpeechSettingsStore.setIncludeVisibleTerminalContext(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsToggleRow(R.drawable.ic_feather_clipboard, "Clipboard Context", speechSettings.includeClipboardContext, tokens) {
                SpeechSettingsStore.setIncludeClipboardContext(context, it)
                speechSettings = SpeechSettingsStore.values(context)
            }
            SettingsValueRow(R.drawable.ic_feather_book, "Custom Vocabulary", "${speechSettings.customVocabulary.lines().count { it.isNotBlank() }} words", "Manage", tokens, chevron = true) { onVocabulary() }
            SettingsValueRow(R.drawable.ic_feather_edit_3, "Prompt", "VoiceInk-style cleanup prompt", "Edit", tokens) { promptDialogOpen = true }
        }
    }
    if (promptDialogOpen) {
        SpeechPromptOverrideDialog(tokens, speechSettings.promptOverride.ifBlank { defaultPrompt }, { promptDialogOpen = false }) {
            SpeechSettingsStore.setPromptOverride(context, it)
            speechSettings = SpeechSettingsStore.values(context)
            promptDialogOpen = false
        }
    }
}

@Composable
internal fun SpeechProvidersSettingsScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    var providers by remember { mutableStateOf(SpeechSettingsStore.providers(context)) }
    var editingProvider by remember { mutableStateOf<SpeechProviderConfig?>(null) }
    var selectedProviderId by remember { mutableStateOf<String?>(null) }

    fun persist(next: List<SpeechProviderConfig>) {
        providers = next.mapIndexed { index, provider -> provider.copy(order = index) }
        SpeechSettingsStore.saveProviders(context, providers)
    }
    selectedProviderId?.let { providerId ->
        val provider = providers.firstOrNull { it.id == providerId }
        if (provider != null) {
            SpeechProviderEndpointsScreen(tokens, provider, onBack = { selectedProviderId = null }) { saved -> persist(providers.map { if (it.id == saved.id) saved else it }) }
            return
        }
        selectedProviderId = null
    }
    SettingsScaffold("Providers", tokens, onBack, R.drawable.ic_feather_plus, { editingProvider = SpeechProviderConfig(System.currentTimeMillis().toString(), "OpenAI-Compatible", emptyList(), SpeechProviderCapability.Both.id, providers.size) }, "Add provider") {
        SettingsSection("OPENAI-COMPATIBLE", tokens) {
            if (providers.isEmpty()) {
                item { Text("No providers configured. Add provider to enable transcription or enhancement.", color = tokens.secondary, fontSize = bodySize(), modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 16.dp)) }
            } else {
                providers.sortedBy { it.order }.forEach { provider ->
                    ProviderConfigRow(tokens, provider, onDelete = { persist(providers.filterNot { it.id == provider.id }) }, onClick = { selectedProviderId = provider.id })
                }
            }
        }
        item { Text("Order matters. App probes providers from top to bottom on startup and network changes. Each provider can support transcription, enhancement, or both.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
    editingProvider?.let { provider ->
        ProviderConfigDialog(tokens, provider, { editingProvider = null }) { saved ->
            persist((providers.filterNot { it.id == saved.id } + saved).sortedBy { it.order })
            editingProvider = null
            selectedProviderId = saved.id
        }
    }
}

@Composable
internal fun ProviderConfigRow(
    tokens: UiTokens,
    provider: SpeechProviderConfig,
    onDelete: () -> Unit,
    onClick: () -> Unit,
) {
    SettingsRow(R.drawable.ic_feather_server, provider.name, "${SpeechProviderCapability.byId(provider.capability).label} · ${provider.aliases.size} endpoint(s) · API key ${if (LocalContext.current.let { SpeechSettingsStore.hasApiKeyForProvider(it, provider.id) }) "stored" else "missing"}", tokens, onClick) {
        Text(
            "Delete",
            color = Color(0xffff5c7a),
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            modifier =
                Modifier
                    .clip(RoundedCornerShape(10.dp))
                    .clickable {
                        hapticClick()
                        onDelete()
                    }.padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}

internal fun moveProvider(
    providers: List<SpeechProviderConfig>,
    id: String,
    delta: Int,
): List<SpeechProviderConfig> {
    val sorted = providers.sortedBy { it.order }.toMutableList()
    val index = sorted.indexOfFirst { it.id == id }
    val target = (index + delta).coerceIn(0, sorted.lastIndex)
    if (index >= 0 && index != target) java.util.Collections.swap(sorted, index, target)
    return sorted.mapIndexed { order, provider -> provider.copy(order = order) }
}

@Composable
internal fun SpeechProviderEndpointsScreen(
    tokens: UiTokens,
    provider: SpeechProviderConfig,
    onBack: () -> Unit,
    onSave: (SpeechProviderConfig) -> Unit,
) {
    var addDialog by remember { mutableStateOf(false) }
    var editDialog by remember { mutableStateOf(false) }
    SettingsScaffold(provider.name, tokens, onBack, R.drawable.ic_feather_plus, { addDialog = true }, "Add endpoint") {
        SettingsSection("PROVIDER", tokens) {
            SettingsValueRow(R.drawable.ic_feather_server, "Name", provider.name, "Edit", tokens) { editDialog = true }
            SettingsValueRow(R.drawable.ic_feather_check, "Capability", SpeechProviderCapability.byId(provider.capability).label, "Edit", tokens) { editDialog = true }
        }
        SettingsSection("ENDPOINTS", tokens) {
            if (provider.aliases.isEmpty()) {
                item { Text("No endpoints. Add LAN, Tailscale, or public HTTPS endpoint.", color = tokens.secondary, fontSize = bodySize(), modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 16.dp)) }
            } else {
                provider.aliases.forEachIndexed { index, endpoint ->
                    SettingsRow(R.drawable.ic_feather_globe, endpoint, if (index == 0) "First priority" else "Fallback #${index + 1}", tokens, {}) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("↑", color = tokens.secondary, fontSize = 18.sp, modifier = Modifier.width(28.dp).clickable { onSave(provider.copy(aliases = moveEndpoint(provider.aliases, endpoint, -1))) }, textAlign = TextAlign.Center)
                            Text("↓", color = tokens.secondary, fontSize = 18.sp, modifier = Modifier.width(28.dp).clickable { onSave(provider.copy(aliases = moveEndpoint(provider.aliases, endpoint, 1))) }, textAlign = TextAlign.Center)
                            Text("Remove", color = Color(0xffff5c7a), fontSize = 11.sp, fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(10.dp)).clickable { onSave(provider.copy(aliases = provider.aliases - endpoint)) }.padding(horizontal = 8.dp, vertical = 6.dp))
                        }
                    }
                }
            }
        }
        item { Text("Endpoints are aliases for this provider. They share one provider API key and are tried in this order during network probe.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
    if (addDialog) {
        SpeechSingleLineDialog(tokens, "Add Endpoint", "", "https://provider.example/v1", { addDialog = false }) { value ->
            val endpoint = value.openAiBaseUrlAliases().firstOrNull()
            if (endpoint != null) onSave(provider.copy(aliases = (provider.aliases + endpoint).distinct()))
            addDialog = false
        }
    }
    if (editDialog) {
        ProviderConfigDialog(tokens, provider, { editDialog = false }) { saved ->
            onSave(saved)
            editDialog = false
        }
    }
}

internal fun moveEndpoint(
    endpoints: List<String>,
    endpoint: String,
    delta: Int,
): List<String> {
    val list = endpoints.toMutableList()
    val index = list.indexOf(endpoint)
    val target = (index + delta).coerceIn(0, list.lastIndex)
    if (index >= 0 && index != target) java.util.Collections.swap(list, index, target)
    return list
}

@Composable
internal fun SettingsSecondsStepperRow(
    icon: Int?,
    title: String,
    value: Int,
    tokens: UiTokens,
    onMinus: () -> Unit,
    onPlus: () -> Unit,
) {
    SettingsRow(icon, title, null, tokens, {}) {
        Row(Modifier.clip(RoundedCornerShape(28.dp)).background(tokens.separator).height(34.dp), verticalAlignment = Alignment.CenterVertically) {
            StepperButton("−", tokens, onMinus)
            Text("${value}s", color = tokens.text, fontSize = bodySize(), modifier = Modifier.width(54.dp), textAlign = TextAlign.Center)
            StepperButton("+", tokens, onPlus)
        }
    }
}

internal fun SpeechSettingsValues.vadSensitivityLabel(): String =
    when (vadSensitivity.coerceIn(0, 4)) {
        0 -> "Very low"
        1 -> "Low"
        2 -> "Normal"
        3 -> "High"
        else -> "Very high"
    }

@Composable
internal fun SpeechLanguageSelectionScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val selectedCode = SpeechSettingsStore.values(context).realtimeTranscriptionLanguage
    SettingsScaffold("Language", tokens, onBack) {
        SettingsSection("TRANSCRIPTION LANGUAGE", tokens) {
            speechLanguageOptions.forEach { language ->
                SettingsValueRow(R.drawable.ic_feather_book, language.label, language.code, if (language.code == selectedCode) "✓" else null, tokens) {
                    SpeechSettingsStore.setRealtimeTranscriptionLanguage(context, language.code)
                    onBack()
                }
            }
        }
    }
}

@Composable
internal fun SpeechProviderSelectionScreen(
    tokens: UiTokens,
    task: String,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val settings = SpeechSettingsStore.values(context)
    val providerTask = if (task == "enhancement") OpenAiProviderTask.Enhancement else OpenAiProviderTask.Transcription
    val selectedProviderId = if (providerTask == OpenAiProviderTask.Enhancement) settings.enhancementProviderId else settings.realtimeTranscriptionProviderId
    val providers = SpeechSettingsStore.providers(context).providersForTask(providerTask)
    SettingsScaffold(if (providerTask == OpenAiProviderTask.Enhancement) "Enhancement Provider" else "Transcription Provider", tokens, onBack) {
        SettingsSection("PROVIDERS", tokens) {
            if (providers.isEmpty()) {
                item { Text("No providers support this task. Add provider from Speech → Providers.", color = tokens.secondary, fontSize = bodySize(), modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 16.dp)) }
            } else {
                providers.forEach { provider ->
                    SettingsValueRow(R.drawable.ic_feather_server, provider.name, "${SpeechProviderCapability.byId(provider.capability).label} · ${provider.aliases.size} endpoint(s)", if (provider.id == selectedProviderId) "✓" else null, tokens) {
                        if (providerTask == OpenAiProviderTask.Enhancement) {
                            SpeechSettingsStore.setEnhancementProviderId(context, provider.id)
                            SpeechSettingsStore.setEnhancementBaseUrl(context, provider.aliases.joinToString("\n"))
                        } else {
                            SpeechSettingsStore.setRealtimeTranscriptionProviderId(context, provider.id)
                            SpeechSettingsStore.setRealtimeTranscriptionBaseUrl(context, provider.aliases.joinToString("\n"))
                        }
                        onBack()
                    }
                }
            }
        }
    }
}

internal data class SpeechLanguageOption(
    val code: String,
    val label: String,
)

internal fun speechLanguageLabel(code: String): String = speechLanguageOptions.firstOrNull { it.code == code }?.let { "${it.label} (${it.code})" } ?: code

internal val speechLanguageOptions =
    listOf(
        "en" to "English",
        "zh" to "Chinese",
        "de" to "German",
        "es" to "Spanish",
        "ru" to "Russian",
        "ko" to "Korean",
        "fr" to "French",
        "ja" to "Japanese",
        "pt" to "Portuguese",
        "tr" to "Turkish",
        "pl" to "Polish",
        "ca" to "Catalan",
        "nl" to "Dutch",
        "ar" to "Arabic",
        "sv" to "Swedish",
        "it" to "Italian",
        "id" to "Indonesian",
        "hi" to "Hindi",
        "fi" to "Finnish",
        "vi" to "Vietnamese",
        "he" to "Hebrew",
        "uk" to "Ukrainian",
        "el" to "Greek",
        "ms" to "Malay",
        "cs" to "Czech",
        "ro" to "Romanian",
        "da" to "Danish",
        "hu" to "Hungarian",
        "ta" to "Tamil",
        "no" to "Norwegian",
        "th" to "Thai",
        "ur" to "Urdu",
        "hr" to "Croatian",
        "bg" to "Bulgarian",
        "lt" to "Lithuanian",
        "la" to "Latin",
        "mi" to "Maori",
        "ml" to "Malayalam",
        "cy" to "Welsh",
        "sk" to "Slovak",
        "te" to "Telugu",
        "fa" to "Persian",
        "lv" to "Latvian",
        "bn" to "Bengali",
        "sr" to "Serbian",
        "az" to "Azerbaijani",
        "sl" to "Slovenian",
        "kn" to "Kannada",
        "et" to "Estonian",
        "mk" to "Macedonian",
        "br" to "Breton",
        "eu" to "Basque",
        "is" to "Icelandic",
        "hy" to "Armenian",
        "ne" to "Nepali",
        "mn" to "Mongolian",
        "bs" to "Bosnian",
        "kk" to "Kazakh",
        "sq" to "Albanian",
        "sw" to "Swahili",
        "gl" to "Galician",
        "mr" to "Marathi",
        "pa" to "Punjabi",
        "si" to "Sinhala",
        "km" to "Khmer",
        "sn" to "Shona",
        "yo" to "Yoruba",
        "so" to "Somali",
        "af" to "Afrikaans",
        "oc" to "Occitan",
        "ka" to "Georgian",
        "be" to "Belarusian",
        "tg" to "Tajik",
        "sd" to "Sindhi",
        "gu" to "Gujarati",
        "am" to "Amharic",
        "yi" to "Yiddish",
        "lo" to "Lao",
        "uz" to "Uzbek",
        "fo" to "Faroese",
        "ht" to "Haitian Creole",
        "ps" to "Pashto",
        "tk" to "Turkmen",
        "nn" to "Norwegian Nynorsk",
        "mt" to "Maltese",
        "sa" to "Sanskrit",
        "lb" to "Luxembourgish",
        "my" to "Myanmar",
        "bo" to "Tibetan",
        "tl" to "Tagalog",
        "mg" to "Malagasy",
        "as" to "Assamese",
        "tt" to "Tatar",
        "haw" to "Hawaiian",
        "ln" to "Lingala",
        "ha" to "Hausa",
        "ba" to "Bashkir",
        "jw" to "Javanese",
        "su" to "Sundanese",
        "yue" to "Cantonese",
    ).map { SpeechLanguageOption(it.first, it.second) }

@Composable
internal fun ProviderConfigDialog(
    tokens: UiTokens,
    provider: SpeechProviderConfig,
    onDismiss: () -> Unit,
    onSave: (SpeechProviderConfig) -> Unit,
) {
    val context = LocalContext.current
    var name by remember(provider.id) { mutableStateOf(provider.name) }
    var capability by remember(provider.id) { mutableStateOf(SpeechProviderCapability.byId(provider.capability)) }
    var apiKey by remember(provider.id) { mutableStateOf("") }
    ThemedAlertDialog(
        onDismissRequest = onDismiss,
        tokens = tokens,
        title = { Text(if (provider.id in SpeechSettingsStore.providers(context).map { it.id }) "Edit Provider" else "Add Provider") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                BasicTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    textStyle =
                        androidx.compose.ui.text
                            .TextStyle(color = tokens.text, fontSize = bodySize()),
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(tokens.surface)
                            .padding(12.dp),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SpeechProviderCapability.all.forEach { option ->
                        Text(
                            option.label,
                            color = if (capability == option) tokens.accent else tokens.secondary,
                            fontSize = captionSize(),
                            fontWeight = FontWeight.Bold,
                            modifier =
                                Modifier
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(if (capability == option) tokens.accent.copy(alpha = 0.14f) else tokens.surface)
                                    .clickable { capability = option }
                                    .padding(horizontal = 10.dp, vertical = 7.dp),
                        )
                    }
                }
                BasicTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    singleLine = true,
                    textStyle =
                        androidx.compose.ui.text
                            .TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace),
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(tokens.surface)
                            .padding(12.dp),
                )
                Text(if (SpeechSettingsStore.hasApiKeyForProvider(context, provider.id)) "API key stored. Enter new key to replace, blank keeps existing key." else "Enter provider API key. Blank allowed for local unauthenticated providers.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 18.sp)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (apiKey.isNotBlank()) SpeechSettingsStore.setApiKeyForProvider(context, provider.id, apiKey)
                onSave(provider.copy(name = name.ifBlank { "OpenAI-Compatible" }, capability = capability.id))
            }) { Text("Save", color = tokens.accent) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.secondary) } },
    )
}

internal fun providerEndpointSummary(
    task: OpenAiProviderTask,
    configuredBaseUrls: String,
): String {
    val contextlessAliases = configuredBaseUrls.openAiBaseUrlAliases()
    val aliases = contextlessAliases
    val state = OpenAiProviderEndpointResolver.state(task)
    return when {
        state.healthy && state.baseUrl.isNotBlank() -> "Using ${state.baseUrl} · ${aliases.size} endpoint(s)"
        aliases.isEmpty() -> "Missing"
        else -> "${aliases.size} endpoint(s) · probing"
    }
}

@Composable
internal fun SpeechProviderModelsScreen(
    tokens: UiTokens,
    initialTask: String,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val httpClient = remember { HttpClient(OkHttp) }
    var speechSettings by remember { mutableStateOf(SpeechSettingsStore.values(context)) }
    var task by remember(initialTask) { mutableStateOf(initialTask) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var models by remember { mutableStateOf<List<OpenAiModelCard>>(emptyList()) }
    var loadJob by remember { mutableStateOf<Job?>(null) }

    fun load(force: Boolean = false) {
        val requestedTask = task
        loadJob?.cancel()
        loading = true
        error = null
        loadJob =
            scope.launch {
                val latest = SpeechSettingsStore.values(context)
                val providerTask = if (requestedTask == "transcription") OpenAiProviderTask.Transcription else OpenAiProviderTask.Enhancement
                val configuredBaseUrls = if (requestedTask == "transcription") latest.realtimeTranscriptionBaseUrl else latest.enhancementBaseUrl
                val providerId = if (requestedTask == "transcription") latest.realtimeTranscriptionProviderId else latest.enhancementProviderId
                val aliases = SpeechSettingsStore.providers(context).endpointsForSelected(providerTask, providerId).ifEmpty { configuredBaseUrls.openAiBaseUrlAliases() }
                val active = OpenAiProviderEndpointResolver.state(providerTask).baseUrl.takeIf { it.isNotBlank() }
                val baseUrls = if (active != null) listOf(active) else aliases
                OpenAiModelDiscoveryCache.models(httpClient, baseUrls, { SpeechSettingsStore.apiKeyForEndpoint(context, it) }, force).fold(
                    onSuccess = {
                        if (task == requestedTask) {
                            models = it
                            error = null
                        }
                    },
                    onFailure = {
                        if (task == requestedTask) {
                            models = emptyList()
                            error = it.message ?: "Model discovery failed"
                        }
                    },
                )
                if (task == requestedTask) loading = false
            }
    }
    LaunchedEffect(task) { load(false) }
    DisposableEffect(httpClient) {
        onDispose {
            loadJob?.cancel()
            httpClient.close()
        }
    }
    SettingsScaffold("Provider Models", tokens, onBack, R.drawable.ic_feather_rotate_ccw, { load(true) }, "Refresh models") {
        SettingsSection("TASK", tokens) {
            SettingsValueRow(R.drawable.ic_feather_mic, "Transcription", "${speechSettings.realtimeTranscriptionBaseUrl.openAiBaseUrlAliases().size} endpoint(s)", if (task == "transcription") "✓" else null, tokens) { task = "transcription" }
            SettingsValueRow(R.drawable.ic_feather_message_circle, "Enhancement", "${speechSettings.enhancementBaseUrl.openAiBaseUrlAliases().size} endpoint(s)", if (task == "enhancement") "✓" else null, tokens) { task = "enhancement" }
        }
        item { Text("MODELS · ${if (loading) "loading" else models.size}", color = tokens.secondary, fontSize = sectionSize(), letterSpacing = 0.6.sp, modifier = Modifier.padding(start = spacingLarge(), end = spacingLarge(), top = 14.dp, bottom = 7.dp)) }
        if (loading) {
            items(5) {
                CoderShimmerBox(
                    tokens,
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = spacingLarge(), vertical = 6.dp)
                        .height(74.dp)
                        .clip(RoundedCornerShape(18.dp)),
                )
            }
        } else if (error != null) {
            item { Text(error.orEmpty(), color = Color(0xffff5c7a), fontSize = captionSize(), lineHeight = 18.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 14.dp)) }
        } else if (models.isEmpty()) {
            item { Text("No models returned by provider.", color = tokens.secondary, fontSize = captionSize(), modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 14.dp)) }
        } else {
            items(models, key = { it.id }) { model ->
                OpenAiModelCardRow(tokens, model, selected = if (task == "transcription") model.id == speechSettings.realtimeTranscriptionModel else model.id == speechSettings.enhancementModel) {
                    val selectedTask = task
                    if (selectedTask == "transcription") SpeechSettingsStore.setRealtimeTranscriptionModel(context, model.id) else SpeechSettingsStore.setEnhancementModel(context, model.id)
                    speechSettings = SpeechSettingsStore.values(context)
                }
            }
        }
        item { Text("Model list comes from standard /v1/models and is cached for 5 minutes. Refresh forces provider probe. Endpoint aliases are tried in order.", color = tokens.secondary, fontSize = captionSize(), lineHeight = 19.sp, modifier = Modifier.padding(horizontal = spacingLarge(), vertical = 18.dp)) }
    }
}

@Composable
internal fun OpenAiModelCardRow(
    tokens: UiTokens,
    model: OpenAiModelCard,
    selected: Boolean,
    onSelect: () -> Unit,
) {
    Column(
        Modifier
            .padding(horizontal = spacingLarge(), vertical = 6.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(tokens.surfaceHigh)
            .clickable {
                hapticClick()
                onSelect()
            }.padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(painterResource(R.drawable.ic_feather_cpu), null, tint = tokens.secondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Text(model.id, color = tokens.text, fontSize = rowTitleSize(), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (selected) Text("ACTIVE", color = tokens.accent, fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
        Text(listOfNotNull(model.ownedBy.takeIf { it.isNotBlank() }?.let { "owner $it" }, model.created.takeIf { it > 0 }?.let { "created $it" }).joinToString(" · ").ifBlank { "OpenAI-compatible model" }, color = tokens.secondary, fontSize = captionSize(), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
internal fun SpeechVocabularySettingsScreen(
    tokens: UiTokens,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    var words by remember {
        mutableStateOf(
            SpeechSettingsStore
                .values(context)
                .customVocabulary
                .lines()
                .map(String::trim)
                .filter(String::isNotBlank),
        )
    }
    var addDialog by remember { mutableStateOf(false) }
    var addValue by remember { mutableStateOf("") }
    var addError by remember { mutableStateOf<String?>(null) }

    fun persist(next: List<String>) {
        SpeechSettingsStore.setCustomVocabulary(context, next.joinToString("\n"))
        words =
            SpeechSettingsStore
                .values(context)
                .customVocabulary
                .lines()
                .map(String::trim)
                .filter(String::isNotBlank)
    }

    fun addWord() {
        val value = addValue.trim()
        if (value.isBlank()) {
            addError = "Enter a word, phrase, function, file, or technical term"
            return
        }
        persist((words + value).distinct().sortedWith(String.CASE_INSENSITIVE_ORDER))
        addValue = ""
        addError = null
        addDialog = false
    }
    SettingsScaffold("Custom Vocabulary", tokens, onBack, R.drawable.ic_feather_plus, { addDialog = true }) {
        SettingsSection("CUSTOM VOCABULARY", tokens) {
            if (words.isEmpty()) {
                item {
                    Text("No vocabulary yet. Add words, proper nouns, function names, file names, and technical terms you use often.", color = tokens.secondary, fontSize = bodySize(), lineHeight = 20.sp, modifier = Modifier.fillMaxWidth().padding(horizontal = spacingLarge(), vertical = 16.dp))
                }
            } else {
                words.forEach { word ->
                    SettingsRow(R.drawable.ic_feather_book, word, "Used for enhancement spelling context", tokens, {}) {
                        Text("Remove", color = Color(0xffff5c7a), fontSize = captionSize(), fontWeight = FontWeight.Bold, modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable { persist(words - word) }.padding(horizontal = 10.dp, vertical = 7.dp))
                    }
                }
            }
        }
    }
    if (addDialog) {
        ThemedAlertDialog(
            onDismissRequest = {
                addDialog = false
                addError = null
            },
            tokens = tokens,
            title = { Text("Add vocabulary") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    BasicTextField(
                        value = addValue,
                        onValueChange = {
                            addValue = it.take(160)
                            addError = null
                        },
                        singleLine = true,
                        textStyle = TextStyle(color = tokens.text, fontSize = bodySize(), fontFamily = FontFamily.Monospace),
                        cursorBrush = SolidColor(tokens.accent),
                        modifier =
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(tokens.surface)
                                .padding(12.dp),
                    )
                    Text(addError ?: "Examples: Realtime API, CoderSheetComponents.kt, dictation", color = if (addError == null) tokens.secondary else Color(0xffff5c7a), fontSize = captionSize(), lineHeight = 18.sp)
                }
            },
            confirmButton = { TextButton(onClick = { addWord() }) { Text("Add", color = tokens.accent) } },
            dismissButton = {
                TextButton(onClick = {
                    addDialog = false
                    addError = null
                }) { Text("Cancel", color = tokens.secondary) }
            },
        )
    }
}

@Composable
internal fun SpeechChoiceDialog(
    tokens: UiTokens,
    title: String,
    options: List<String>,
    selected: String,
    onDismiss: () -> Unit,
    onSelect: (String) -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        shape = RoundedCornerShape(24.dp),
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                options.forEach { option ->
                    SettingsValueRow(R.drawable.ic_feather_check, option, null, if (option == selected) "✓" else null, tokens) { onSelect(option) }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.text) } },
    )
}

@Composable
internal fun SpeechSingleLineDialog(
    tokens: UiTokens,
    title: String,
    initialValue: String,
    placeholder: String,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var value by remember(initialValue) { mutableStateOf(initialValue) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = tokens.surfaceHigh,
        titleContentColor = tokens.text,
        textContentColor = tokens.secondary,
        shape = RoundedCornerShape(24.dp),
        title = { Text(title) },
        text = { CoderTextField(value, { value = it }, placeholder, tokens) },
        confirmButton = { TextButton(onClick = { onSave(value) }) { Text("Save", color = tokens.accent) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.text) } },
    )
}

@Composable
internal fun SpeechPromptOverrideDialog(
    tokens: UiTokens,
    initialPrompt: String,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
) {
    var prompt by remember { mutableStateOf(initialPrompt) }
    ThemedAlertDialog(
        onDismissRequest = onDismiss,
        tokens = tokens,
        title = { Text("Enhancement Prompt") },
        text = {
            BasicTextField(
                value = prompt,
                onValueChange = { prompt = it.take(8_000) },
                textStyle = TextStyle(color = tokens.text, fontSize = captionSize(), fontFamily = FontFamily.Monospace),
                cursorBrush = SolidColor(tokens.accent),
                modifier =
                    Modifier
                        .fillMaxWidth()
                        .height(220.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(tokens.surfaceHigh)
                        .padding(12.dp),
            )
        },
        confirmButton = { TextButton(onClick = { onSave(prompt) }) { Text("Save", color = tokens.accent) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = tokens.text) } },
    )
}
