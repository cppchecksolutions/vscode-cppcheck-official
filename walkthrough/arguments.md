

Cppcheck works best for you if you set it up according to your needs. You may e.g. want to disable certain kinds of warnings. Cppcheck Premium works without extra setup, but Premium checks such as `--premium=misra-c-2023` have to be enabled. All of this is done through the extension property 'arguments', with the different flags or arguments available being detailed in the Cppcheck manual ([open source](https://cppcheck.sourceforge.io/manual.pdf#page=4) / [Premium](https://files.cppchecksolutions.com/manual.pdf#page=4)). The Premium checks are described in the [Premium manual](https://files.cppchecksolutions.com/manual.pdf#page=44).

To make sure that you and your team work with the same set up, it is recommended to put the arguments in a `cppcheck.json` file in the root of your workspace and commit it to version control, e.g. `{ "arguments": "--project=build/compile_commands.json" }`. Arguments in this file take precedence over the arguments setting. Furthermore you are likely to want to have the same settings between VS Code and your CI workflows. This is most easily done through project files, which are referenced from the argument setting (see the Cppcheck manual ([open source](https://cppcheck.sourceforge.io/manual.pdf#page=10) / [Premium](https://files.cppchecksolutions.com/manual.pdf#page=10)) for how to create a project file).

![image showing project file path being set in arguments property](../images/project_file.png)

Another way of syncing your set up between different environments is through using scripts. The argument property supports running scripts with the syntax `@(/path/to/script.sh)`. The extension expects this script to output what to use for arguments wrapped with `@()`, so e.g. `echo "@(--report-progress --enable=style --inconclusive --suppress=syntaxError)"`.


[Set up arguments](command:cppcheck-official.configureArguments)