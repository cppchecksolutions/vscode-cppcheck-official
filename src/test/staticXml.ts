export const mulitpleLocationWarningUri = "src/example.cpp";
export const multiLocationWarningXml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <results version="2">
        <errors>
            <error
                id="nullPointer"
                severity="error"
                msg="Possible null pointer dereference: ptr"
                verbose="Possible null pointer dereference: ptr"
                cwe="476">
                <location
                    file="src/example.cpp"
                    line="15"
                    column="5"/>
                <location
                    file="src/example.cpp"
                    line="10"
                    column="10"
                    info="Assignment 'ptr=nullptr', assigned value is null"/>
                <location
                    file="src/example.cpp"
                    line="14"
                    column="5"
                    info="Calling function 'process', 1st argument 'ptr' value is null"/>
            </error>
        </errors>
    </results>`;