rootProject.name = "multi-module-app"

// Comment with include("ignored") inside a comment
/* Block comment also has include("also-ignored") */

include(":foo", ":bar:baz")
