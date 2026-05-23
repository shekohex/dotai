package com.coder.pi

fun terminalAccessibleLines(
    snapshotRows: List<String>,
    terminalRows: Int,
): List<TerminalAccessibleLine> =
    snapshotRows
        .take(terminalRows)
        .mapIndexedNotNull { index, text ->
            val trimmed = text.trimEnd()
            if (trimmed.isBlank()) null else TerminalAccessibleLine(index, trimmed)
        }
