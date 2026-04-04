package com.example.demo

/**
 * Service class for business logic.
 */
class Bar(private val repository: FooRepository) {
    
    fun findById(id: Long): Foo? {
        return repository.findById(id)
    }
    
    fun save(foo: Foo): Foo {
        require(foo.isValid()) { "Invalid foo object" }
        return repository.save(foo)
    }
}
