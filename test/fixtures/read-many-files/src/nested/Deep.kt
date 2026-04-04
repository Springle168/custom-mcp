package com.example.demo.nested

/**
 * A deeply nested utility class.
 */
object Deep {
    
    fun formatMessage(text: String): String {
        return "[DEEP] $text"
    }
    
    fun calculate(a: Int, b: Int): Int {
        return a * b + 42
    }
}
