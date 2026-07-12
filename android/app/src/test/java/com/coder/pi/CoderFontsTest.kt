package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoderFontsTest {
    @Test
    fun onlyJetBrainsAndMapleShipInApk() {
        assertEquals(listOf("jetbrains", "maple"), CoderFonts.builtInOptions().map { it.key })
    }

    @Test
    fun removedBundledFontsRemainAvailableForDownload() {
        val downloadable = CoderFonts.downloadableOptions()

        assertEquals(listOf("iosevka", "ibm_plex"), downloadable.map { it.key })
        assertTrue(downloadable.all { it.faces.size == 5 })
        assertTrue(downloadable.flatMap { it.faces }.all { it.url.startsWith("https://") })
        assertTrue(downloadable.flatMap { it.faces }.all { it.sha256.matches(Regex("[0-9a-f]{64}")) })
    }
}
