package com.coder.pi

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri

data class TerminalNotificationSound(val id: String, val label: String, val resourceName: String)

object TerminalNotificationSounds {
    const val defaultSoundId = "alert-01"

    val options = listOf(
        TerminalNotificationSound("alert-01", "Alert 01", "alert_01"),
        TerminalNotificationSound("alert-02", "Alert 02", "alert_02"),
        TerminalNotificationSound("alert-03", "Alert 03", "alert_03"),
        TerminalNotificationSound("alert-04", "Alert 04", "alert_04"),
        TerminalNotificationSound("alert-05", "Alert 05", "alert_05"),
        TerminalNotificationSound("alert-06", "Alert 06", "alert_06"),
        TerminalNotificationSound("alert-07", "Alert 07", "alert_07"),
        TerminalNotificationSound("alert-08", "Alert 08", "alert_08"),
        TerminalNotificationSound("alert-09", "Alert 09", "alert_09"),
        TerminalNotificationSound("alert-10", "Alert 10", "alert_10"),
        TerminalNotificationSound("bip-bop-01", "Bip Bop 01", "bip_bop_01"),
        TerminalNotificationSound("bip-bop-02", "Bip Bop 02", "bip_bop_02"),
        TerminalNotificationSound("bip-bop-03", "Bip Bop 03", "bip_bop_03"),
        TerminalNotificationSound("bip-bop-04", "Bip Bop 04", "bip_bop_04"),
        TerminalNotificationSound("bip-bop-05", "Bip Bop 05", "bip_bop_05"),
        TerminalNotificationSound("bip-bop-06", "Bip Bop 06", "bip_bop_06"),
        TerminalNotificationSound("bip-bop-07", "Bip Bop 07", "bip_bop_07"),
        TerminalNotificationSound("bip-bop-08", "Bip Bop 08", "bip_bop_08"),
        TerminalNotificationSound("bip-bop-09", "Bip Bop 09", "bip_bop_09"),
        TerminalNotificationSound("bip-bop-10", "Bip Bop 10", "bip_bop_10"),
        TerminalNotificationSound("staplebops-01", "Staplebops 01", "staplebops_01"),
        TerminalNotificationSound("staplebops-02", "Staplebops 02", "staplebops_02"),
        TerminalNotificationSound("staplebops-03", "Staplebops 03", "staplebops_03"),
        TerminalNotificationSound("staplebops-04", "Staplebops 04", "staplebops_04"),
        TerminalNotificationSound("staplebops-05", "Staplebops 05", "staplebops_05"),
        TerminalNotificationSound("staplebops-06", "Staplebops 06", "staplebops_06"),
        TerminalNotificationSound("staplebops-07", "Staplebops 07", "staplebops_07"),
        TerminalNotificationSound("nope-01", "Nope 01", "nope_01"),
        TerminalNotificationSound("nope-02", "Nope 02", "nope_02"),
        TerminalNotificationSound("nope-03", "Nope 03", "nope_03"),
        TerminalNotificationSound("nope-04", "Nope 04", "nope_04"),
        TerminalNotificationSound("nope-05", "Nope 05", "nope_05"),
        TerminalNotificationSound("nope-06", "Nope 06", "nope_06"),
        TerminalNotificationSound("nope-07", "Nope 07", "nope_07"),
        TerminalNotificationSound("nope-08", "Nope 08", "nope_08"),
        TerminalNotificationSound("nope-09", "Nope 09", "nope_09"),
        TerminalNotificationSound("nope-10", "Nope 10", "nope_10"),
        TerminalNotificationSound("nope-11", "Nope 11", "nope_11"),
        TerminalNotificationSound("nope-12", "Nope 12", "nope_12"),
        TerminalNotificationSound("yup-01", "Yup 01", "yup_01"),
        TerminalNotificationSound("yup-02", "Yup 02", "yup_02"),
        TerminalNotificationSound("yup-03", "Yup 03", "yup_03"),
        TerminalNotificationSound("yup-04", "Yup 04", "yup_04"),
        TerminalNotificationSound("yup-05", "Yup 05", "yup_05"),
        TerminalNotificationSound("yup-06", "Yup 06", "yup_06"),
    )

    fun option(id: String): TerminalNotificationSound = options.firstOrNull { it.id == id } ?: options.first()

    fun next(id: String): TerminalNotificationSound {
        val index = options.indexOfFirst { it.id == id }.takeIf { it >= 0 } ?: 0
        return options[(index + 1) % options.size]
    }

    fun selectedId(context: Context): String = option(context.getSharedPreferences("terminal", Context.MODE_PRIVATE).getString("osc.notifications.sound", defaultSoundId).orEmpty()).id

    fun uri(context: Context, id: String): Uri {
        val sound = option(id)
        val resourceId = context.resources.getIdentifier(sound.resourceName, "raw", context.packageName)
        return Uri.parse("android.resource://${context.packageName}/$resourceId")
    }

    fun channelSuffix(id: String): String = option(id).resourceName

    fun playPreview(context: Context, id: String) {
        val player = MediaPlayer.create(context, uri(context, id)) ?: return
        player.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        player.setOnCompletionListener { it.release() }
        player.setOnErrorListener { mediaPlayer, _, _ -> mediaPlayer.release(); true }
        player.start()
    }
}
