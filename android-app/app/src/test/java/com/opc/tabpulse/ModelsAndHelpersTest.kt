package com.opc.tabpulse

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelsAndHelpersTest {

    @Test
    fun normalizeHttpUrl_handlesRawAndInvalidUrls() {
        assertEquals("https://www.goofish.com/im", UrlHelpers.normalizeHttpUrl("www.goofish.com/im"))
        assertEquals("https://creator.xiaohongshu.com/new/home", UrlHelpers.normalizeHttpUrl("https://creator.xiaohongshu.com/new/home"))
        assertNull(UrlHelpers.normalizeHttpUrl("javascript:alert(1)"))
        assertNull(UrlHelpers.normalizeHttpUrl("not-a-domain"))
        assertNull(UrlHelpers.normalizeHttpUrl("   "))
    }

    @Test
    fun extractRootDomain_handlesStandardAndMultiPartTlds() {
        assertEquals("goofish.com", UrlHelpers.extractRootDomain("www.goofish.com"))
        assertEquals("xiaohongshu.com", UrlHelpers.extractRootDomain("creator.xiaohongshu.com"))
        assertEquals("example.com.cn", UrlHelpers.extractRootDomain("im.shop.example.com.cn"))
        assertEquals("192.168.1.5", UrlHelpers.extractRootDomain("192.168.1.5"))
    }

    @Test
    fun buildPromotedCookieHeader_promotesSessionCookieToOneYear() {
        val h1 = UrlHelpers.buildPromotedCookieHeader("sid", "abc123", null, true)
        assertTrue(h1.contains("sid=abc123"))
        assertTrue(h1.contains("Max-Age=31536000"))
        assertTrue(h1.contains("Secure"))
        assertFalse(h1.contains("Domain="))

        val h2 = UrlHelpers.buildPromotedCookieHeader("token", "xyz", "goofish.com", true)
        assertTrue(h2.contains("Domain=.goofish.com"))
    }

    @Test
    fun parseCookiePairs_parsesMultipleCookies() {
        val parsed = UrlHelpers.parseCookiePairs("a=1; b=hello=world; c=3")
        assertEquals(3, parsed.size)
        assertEquals("1", parsed["a"])
        assertEquals("hello=world", parsed["b"])
        assertEquals("3", parsed["c"])
    }

    @Test
    fun shouldTriggerMessageAlert_triggersOnlyOnIncreaseOrFreshNotification() {
        assertTrue(UrlHelpers.shouldTriggerMessageAlert(false, 0, 1, "", "hi", "mutation"))
        assertFalse(UrlHelpers.shouldTriggerMessageAlert(false, 2, 2, "hi", "hi", "mutation"))
        assertFalse(UrlHelpers.shouldTriggerMessageAlert(true, 0, 5, "", "hi", "mutation"))
        assertTrue(UrlHelpers.shouldTriggerMessageAlert(false, 1, 1, "old", "new msg", "notification"))
    }

    @Test
    fun passiveEvent_parsesValidPayload() {
        val evt = PassiveEvent.fromJsonString("""{"event":"mutation","authExpired":false,"unreadCount":3,"snippet":"买家问在吗","pageTitle":"闲鱼"}""")
        assertEquals(3, evt?.unreadCount)
        assertEquals("买家问在吗", evt?.snippet)
        assertFalse(evt?.authExpired ?: true)
    }
}
