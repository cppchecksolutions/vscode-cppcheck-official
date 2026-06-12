const documentationLinkMap : Record<string, string> = {
  'constParameterPointer': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/constParameterPointer.md',
  'cstyleCast': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/cstyleCast.md',
  'dangerousTypeCast': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/dangerousTypeCast.md',
  'duplicateExpressionTernary': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/duplicateExpressionTernary.md',
  'duplicateValueTernary': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/duplicateValueTernary.md',
  'fcloseInLoopCondition': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/fcloseInLoopCondition.md',
  'functionConst': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/functionConst.md',
  'functionStatic': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/functionStatic.md',
  'premium-misra-config': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/premium-misra-config.md',
  'preprocessorErrorDirective': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/preprocessorErrorDirective.md',
  'truncLongCast': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/truncLongCast.md',
  'unknownMacro': 'https://github.com/cppcheck-opensource/cppcheck/blob/main/man/checkers/unknownMacro.md',
  /************
  *** CERT ***
  ************/
  // Arrays ARR30-C
  'arrayIndexOutOfBounds': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr30-c',
  'outOfBounds': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr30-c',
  'negativeIndex': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr30-c',
  'arrayIndexThenCheck': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr30-c',
  'arrayIndexOutOfBoundsCond': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr30-c',
  'possibleBufferAccessOutOfBounds': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr30-c',
  // Arrays ARR32-C
  'negativeArraySize': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr32-c',
  // Arrays ARR36-C
  'comparePointers': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/arrays-arr/arr36-c',
  // Declarations and Initialization DCL30-C
  'danglingLifetime': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/declarations-and-initialization-dcl/dcl30-c',
  'returnDanglingLifetime': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/declarations-and-initialization-dcl/dcl30-c',
  'autoVariables': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/declarations-and-initialization-dcl/dcl30-c',
  'invalidLifetime': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/declarations-and-initialization-dcl/dcl30-c',
  // Expressions EXP30-C
  'unknownEvaluationOrder': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp30-c',
  // Expressions EXP33-C
  'uninitvar': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp33-c',
  'uninitdata': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp33-c',
  'uninitstring': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp33-c',
  'uninitMemberVar': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp33-c',
  'uninitStructMember': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp33-c',
  // Expressions EXP34-C
  'nullPointer': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp34-c',
  'nullPointerDefaultArg': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp34-c',
  'nullPointerRedundantCheck': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp34-c',
  // Expressions EXP46-C
  'bitwiseOnBoolean': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/expressions-exp/exp46-c',
  // Floating Point FLP34-C
  'floatConversionOverflow' : 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/floating-point-flp/flp34-c',
  'suspiciousFloatingPointCast': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/floating-point-flp/flp34-c',
  // Input Output FIO39-C
  'IOWithoutPositioning': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio39-c',
  // Input Output FIO42-C
  'resourceLeak': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio42-c',
  // Input Output FIO47-C 
  'invalidscanf': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio47-c',
  'wrongPrintfScanfArgNum': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio47-c',
  'invalidLengthModifierError': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio47-c',
  'invalidScanfFormatWidth': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio47-c',
  'wrongPrintfScanfParameterPositionError': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/input-output-fio/fio47-c',
  // Integers INT31-C
  'memsetValueOutOfRange': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/int31-c',
  // Integers INT33-C
  'zerodiv': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/int33-c',
  'zerodivcond': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/int33-c',
  // Integers INT34-C
  'shiftNegative': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/int34-c',
  'shiftTooManyBits': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/integers-int/int34-c',
  // Memory Management MEM30-C
  'doubleFree': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem30-c',
  'deallocret': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem30-c',
  'deallocuse': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem30-c',
  // Memory Management MEM31-C
  'memleak': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem31-c',
  'leakReturnValNotUsed': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem31-c',
  'leakUnsafeArgAlloc': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem31-c',
  'memleakOnRealloc': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem31-c',
  // Memory Management MEM34-C
  'autovarInvalidDeallocation': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem34-c',
  'mismatchAllocDealloc': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/memory-management-mem/mem34-c',
  // Miscellaneous MSC37-C
  'missingReturn': 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/miscellaneous-msc/msc37-c',
};

function getPremiumCertLink(errorCode: string) : string {
  // error codes are expected to be on the format of i.e. premium-cert-arr37-c
  if (!errorCode.includes('premium-cert-')) {
    return '';
  }
  const basicUrl = 'https://cmu-sei.github.io/secure-coding-standards/sei-cert-c-coding-standard/rules/';
  const categoryMap : Record<string, string> = {
    'arr': 'arrays-arr',
    'str': 'characters-and-strings-str',
    'con': 'concurrency-con',
    'dcl': 'declarations-and-initialization-dcl',
    'env': 'environment-env',
    'err': 'error-handling-err',
    'exp': 'expressions-exp',
    'flp': 'floating-point-flp',
    'fio': 'input-output-fio',
    'int': 'integers-int',
    'mem': 'memory-management-mem',
    'win': 'microsoft-windows-win',
    'msc': 'miscellaneous-msc',
    'pos': 'posix-pos',
    'pre': 'preprocessor-pre',
    'sig': 'signals-sig',
  };
  const warningLinkSuffix = errorCode.replace('premium-cert-', '');
  const category = categoryMap[warningLinkSuffix.slice(0,3)];
  if (!category) {
    return '';
  }
  const premiumCertWarningLink = basicUrl + category + '/' + warningLinkSuffix;
  return premiumCertWarningLink;
}

export { documentationLinkMap, getPremiumCertLink };