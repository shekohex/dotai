package com.coder.pi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CoderOscHyperlinkTest {
    @Test
    fun acceptsHttpAndHttpsWithAuthority() {
        assertEquals("https", terminalOscHyperlinkUri("https://example.com/path?q=1")?.scheme)
        assertEquals("http", terminalOscHyperlinkUri("http://localhost:8080")?.scheme)
    }

    @Test
    fun rejectsUnsafeOrAmbiguousSchemes() {
        assertNull(terminalOscHyperlinkUri("javascript:alert(1)"))
        assertNull(terminalOscHyperlinkUri("file:///etc/passwd"))
        assertNull(terminalOscHyperlinkUri("https:example.com"))
        assertNull(terminalOscHyperlinkUri("//example.com"))
    }

    @Test
    fun rejectsBlankMalformedAndOversizedValues() {
        assertNull(terminalOscHyperlinkUri(""))
        assertNull(terminalOscHyperlinkUri("http://exa mple.com"))
        assertNull(terminalOscHyperlinkUri("https://example.com/" + "a".repeat(2049)))
    }

    @Test
    fun normalizesAllowedHostKey() {
        assertEquals("example.com", terminalOscHyperlinkHost("HTTPS://Example.COM/path"))
        assertNull(terminalOscHyperlinkHost("file:///tmp/x"))
    }

    @Test
    fun normalizesManualAllowlistPatterns() {
        assertEquals("example.com", terminalNormalizeLinkHostPattern("https://Example.COM/path"))
        assertEquals("*.example.com", terminalNormalizeLinkHostPattern("*.Example.COM"))
        assertNull(terminalNormalizeLinkHostPattern("*."))
        assertNull(terminalNormalizeLinkHostPattern("example.com/path"))
    }
}
