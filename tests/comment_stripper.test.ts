/**
 * Tests: Polyglot Comment Stripper (RED PHASE)
 *
 * Validates language-specific comment and whitespace stripping
 * for the top 12 programming languages. Each test provides
 * before/after content — stripped output must match expected logic.
 */
import { describe, test, expect } from "bun:test";
import { stripForLanguage, detectLanguage, SUPPORTED_EXTENSIONS, type LanguageId } from "../src/core/comment_stripper";

// ─── Language Detection ───────────────────────────────────────────────────────

describe("detectLanguage", () => {
    test("detects all 12 supported extensions", () => {
        const cases: [string, LanguageId][] = [
            ["app.py", "python"],
            ["main.js", "javascript"],
            ["index.ts", "typescript"],
            ["App.java", "java"],
            ["Program.cs", "csharp"],
            ["main.c", "c"],
            ["main.cpp", "cpp"],
            ["main.go", "go"],
            ["lib.rs", "rust"],
            ["index.php", "php"],
            ["app.rb", "ruby"],
            ["ViewController.swift", "swift"],
            ["Main.kt", "kotlin"],
        ];

        for (const [file, expected] of cases) {
            expect(detectLanguage(file)).toBe(expected);
        }
    });

    test("returns null for unsupported extensions", () => {
        expect(detectLanguage("data.csv")).toBeNull();
        expect(detectLanguage("README.md")).toBeNull();
        expect(detectLanguage("Dockerfile")).toBeNull();
    });
});

// ─── C-Family Comments (// and /* */) ─────────────────────────────────────────

describe("C-family comment stripping", () => {
    test("JavaScript: strips single-line and multi-line comments", () => {
        const input = `
// This is a comment
const x = 1;
/* Multi-line
   comment */
const y = x + 2;
`;
        const result = stripForLanguage(input, "javascript");
        expect(result).not.toContain("This is a comment");
        expect(result).not.toContain("Multi-line");
        expect(result).toContain("const x = 1");
        expect(result).toContain("const y = x + 2");
    });

    test("TypeScript: strips comments and type-only constructs via Bun AST", () => {
        const input = `
// Type definition
interface User { name: string; }
/* Helper */
const greet = (u: User): string => u.name;
`;
        const result = stripForLanguage(input, "typescript");
        expect(result).not.toContain("Type definition");
        expect(result).not.toContain("Helper");
        // Bun.Transpiler strips interface declarations (type-only)
        expect(result).toContain("greet");
        expect(result).toContain("u.name");
    });

    test("Java: strips Javadoc and inline comments", () => {
        const input = `
/**
 * A service class.
 * @author dev
 */
public class UserService {
    // Get the user
    public User getUser(int id) {
        return db.find(id); // inline comment
    }
}
`;
        const result = stripForLanguage(input, "java");
        expect(result).not.toContain("@author");
        expect(result).not.toContain("Get the user");
        expect(result).not.toContain("inline comment");
        expect(result).toContain("public class UserService");
        expect(result).toContain("return db.find(id)");
    });

    test("C#: strips XML doc comments and regular comments", () => {
        const input = `
/// <summary>
/// Main entry point.
/// </summary>
class Program {
    // Run the app
    static void Main() {
        Console.WriteLine("Hello"); /* greeting */
    }
}
`;
        const result = stripForLanguage(input, "csharp");
        expect(result).not.toContain("<summary>");
        expect(result).not.toContain("Run the app");
        expect(result).not.toContain("greeting");
        expect(result).toContain("class Program");
        expect(result).toContain("Console.WriteLine");
    });

    test("C: strips preprocessor-adjacent comments", () => {
        const input = `
#include <stdio.h>
// Main function
int main() {
    printf("hello"); /* print greeting */
    return 0;
}
`;
        const result = stripForLanguage(input, "c");
        expect(result).not.toContain("Main function");
        expect(result).not.toContain("print greeting");
        expect(result).toContain("#include");
        expect(result).toContain("printf");
    });

    test("C++: strips single and multi-line", () => {
        const input = `
// Vector operations
#include <vector>
std::vector<int> v = {1, 2, 3};
/* Sort the vector */
std::sort(v.begin(), v.end());
`;
        const result = stripForLanguage(input, "cpp");
        expect(result).not.toContain("Vector operations");
        expect(result).not.toContain("Sort the vector");
        expect(result).toContain("std::vector");
        expect(result).toContain("std::sort");
    });

    test("Go: strips single and multi-line comments", () => {
        const input = `
// Package main provides the entry point.
package main

import "fmt"

/*
  PrintHello prints hello.
*/
func PrintHello() {
    fmt.Println("Hello") // inline
}
`;
        const result = stripForLanguage(input, "go");
        expect(result).not.toContain("Package main provides");
        expect(result).not.toContain("PrintHello prints hello");
        expect(result).not.toContain("inline");
        expect(result).toContain("package main");
        expect(result).toContain("fmt.Println");
    });

    test("Rust: strips doc comments and line comments", () => {
        const input = `
/// A public function.
/// # Examples
pub fn add(a: i32, b: i32) -> i32 {
    // sum
    a + b
}
/* Legacy code */
`;
        const result = stripForLanguage(input, "rust");
        expect(result).not.toContain("A public function");
        expect(result).not.toContain("# Examples");
        expect(result).not.toContain("sum");
        expect(result).not.toContain("Legacy code");
        expect(result).toContain("pub fn add");
        expect(result).toContain("a + b");
    });

    test("Swift: strips single-line, nested multi-line, and doc comments", () => {
        const input = `
/// A greeting function.
func greet(name: String) -> String {
    // Build greeting
    return "Hello, " + name
}
/* Outer /* nested */ comment */
`;
        const result = stripForLanguage(input, "swift");
        expect(result).not.toContain("A greeting function");
        expect(result).not.toContain("Build greeting");
        expect(result).toContain("func greet");
        expect(result).toContain("return");
    });

    test("Kotlin: strips KDoc and line comments", () => {
        const input = `
/**
 * Data class for users.
 * @property name The user's name.
 */
data class User(val name: String) {
    // Convert to string
    override fun toString() = name
}
`;
        const result = stripForLanguage(input, "kotlin");
        expect(result).not.toContain("Data class for users");
        expect(result).not.toContain("@property");
        expect(result).not.toContain("Convert to string");
        expect(result).toContain("data class User");
        expect(result).toContain("override fun toString");
    });

    test("PHP: strips //, /* */, and # comments", () => {
        const input = `
<?php
// Database connection
# Legacy comment style
$conn = new PDO($dsn);
/* Configure
   options */
$conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
?>
`;
        const result = stripForLanguage(input, "php");
        expect(result).not.toContain("Database connection");
        expect(result).not.toContain("Legacy comment style");
        expect(result).not.toContain("Configure");
        expect(result).toContain("new PDO");
        expect(result).toContain("setAttribute");
    });
});

// ─── Python (# and docstrings) ────────────────────────────────────────────────

describe("Python comment stripping", () => {
    test("strips # comments and triple-quote docstrings", () => {
        const input = `
# Main module
"""
This module handles authentication.
"""
def login(user: str, pwd: str) -> bool:
    '''Check credentials'''
    # Validate
    return check_db(user, pwd)
`;
        const result = stripForLanguage(input, "python");
        expect(result).not.toContain("Main module");
        expect(result).not.toContain("This module handles");
        expect(result).not.toContain("Check credentials");
        expect(result).not.toContain("Validate");
        expect(result).toContain("def login");
        expect(result).toContain("return check_db");
    });
});

// ─── Ruby (# comments) ───────────────────────────────────────────────────────

describe("Ruby comment stripping", () => {
    test("strips # comments and =begin/=end blocks", () => {
        const input = `
# Frozen string literal
=begin
This is a multi-line
comment block.
=end
class Greeter
  # Initialize with name
  def initialize(name)
    @name = name
  end
end
`;
        const result = stripForLanguage(input, "ruby");
        expect(result).not.toContain("Frozen string literal");
        expect(result).not.toContain("multi-line");
        expect(result).not.toContain("Initialize with name");
        expect(result).toContain("class Greeter");
        expect(result).toContain("def initialize");
    });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge cases", () => {
    test("preserves string literals that look like comments", () => {
        const input = `const url = "https://example.com"; // real comment`;
        const result = stripForLanguage(input, "javascript");
        expect(result).toContain("https://example.com");
        expect(result).not.toContain("real comment");
    });

    test("empty input returns empty", () => {
        expect(stripForLanguage("", "python")).toBe("");
        expect(stripForLanguage("   ", "go")).toBe("");
    });

    test("SUPPORTED_EXTENSIONS lists all 12+ extensions", () => {
        expect(SUPPORTED_EXTENSIONS.length).toBeGreaterThanOrEqual(13); // .c, .cpp, .cs, .go, .java, .js, .kt, .php, .py, .rb, .rs, .swift, .ts
    });
});
