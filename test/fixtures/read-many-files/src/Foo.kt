package com.example.demo

/**
 * A simple data class representing a user.
 */
data class Foo(
    val id: Long,
    val name: String,
    val email: String
) {
    fun isValid(): Boolean {
        return name.isNotBlank() && email.contains("@")
    }
}
