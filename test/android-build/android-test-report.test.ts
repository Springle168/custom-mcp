import { parseAndroidTestReports } from '../../src/engine/android-test-report.js';
import {
  assertEqual,
  assertIncludes,
  runTestSuite,
} from '../test-utils.js';

function testSingleFailureReport() {
  const result = parseAndroidTestReports([
    {
      relativePath:
        'app/build/test-results/testDebugUnitTest/TEST-ExampleTest.xml',
      xml: `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="ExampleTest" tests="2" skipped="0" failures="1" errors="0">
  <testcase name="passing test" classname="example.ExampleTest"/>
  <testcase name="computed value matches expectation" classname="example.ExampleTest">
    <failure message="Expected &lt;2&gt;, actual &lt;1&gt;." type="java.lang.AssertionError"><![CDATA[java.lang.AssertionError: Expected <2>, actual <1>.
        at kotlin.test.DefaultAsserter.fail(DefaultAsserter.kt:16)
        at example.ExampleTest.computed value matches expectation(ExampleTest.kt:24)]]></failure>
  </testcase>
</testsuite>`,
    },
  ]);

  assertEqual(result.summary.status, 'generated', 'Should parse the report');
  assertEqual(result.summary.reportFiles, 1, 'Should count parsed files');
  assertEqual(result.summary.tests, 2, 'Should keep suite test count');
  assertEqual(result.summary.failures, 1, 'Should keep failure count');
  assertEqual(result.summary.errors, 0, 'Should keep error count');
  assertEqual(result.summary.failedTests?.length, 1, 'Should return one failure detail');
  assertEqual(
    result.summary.failedTests?.[0]?.message,
    'Expected <2>, actual <1>.',
    'Should decode the failure message',
  );
  assertEqual(
    result.summary.failedTests?.[0]?.location,
    'ExampleTest.kt:24',
    'Should prefer the test class source frame',
  );
  assertIncludes(
    result.firstErrorBlock,
    '1 test failed. First failure:',
    'Should format a compact first failure block',
  );
}

function testMultipleReportsAndDetailLimit() {
  const result = parseAndroidTestReports(
    [
      {
        relativePath: 'z/build/test-results/testDebugUnitTest/TEST-Z.xml',
        xml: `<testsuite tests="1" failures="0" errors="1" skipped="0">
  <testcase name="third" classname="demo.ThirdTest">
    <error message="third error" type="java.lang.IllegalStateException">at demo.ThirdTest.third(ThirdTest.java:30)</error>
  </testcase>
</testsuite>`,
      },
      {
        relativePath: 'a/build/test-results/testDebugUnitTest/TEST-A.xml',
        xml: `<testsuites><testsuite tests="2" failures="2" errors="0" skipped="0">
  <testcase name="first" classname="demo.FirstTest">
    <failure message="first failure" type="java.lang.AssertionError">at demo.FirstTest.first(FirstTest.kt:10)</failure>
  </testcase>
  <testcase name="second" classname="demo.SecondTest">
    <failure message="second failure" type="java.lang.AssertionError">at demo.SecondTest.second(SecondTest.kt:20)</failure>
  </testcase>
</testsuite></testsuites>`,
      },
    ],
    2,
  );

  assertEqual(result.summary.reportFiles, 2, 'Should aggregate report files');
  assertEqual(result.summary.tests, 3, 'Should aggregate tests');
  assertEqual(result.summary.failures, 2, 'Should aggregate failures');
  assertEqual(result.summary.errors, 1, 'Should aggregate errors');
  assertEqual(result.summary.failedTests?.length, 2, 'Should apply detail limit');
  assertEqual(
    result.summary.failedTests?.[0]?.name,
    'first',
    'Should use deterministic report path order',
  );
  assertEqual(
    result.summary.omittedFailedTests,
    1,
    'Should report omitted failure details',
  );
}

function testMalformedReportFailsSafely() {
  const result = parseAndroidTestReports([
    {
      relativePath: 'app/build/test-results/testDebugUnitTest/TEST-broken.xml',
      xml: '<testsuite><testcase>',
    },
  ]);

  assertEqual(result.summary.status, 'parse_failed', 'Should report parse failure');
  assertEqual(result.firstErrorBlock, null, 'Should not invent a test diagnosis');
}

function testFailureDetailsAndFirstBlockAreBounded() {
  const longMessage = 'x'.repeat(2000);
  const result = parseAndroidTestReports(
    [
      {
        relativePath: 'app/test-results/testDebugUnitTest/TEST-Large.xml',
        xml: `<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase name="large" classname="demo.LargeTest"><failure message="${longMessage}" type="java.lang.AssertionError">at demo.LargeTest.large(LargeTest.kt:9)</failure></testcase></testsuite>`,
      },
    ],
    10,
    80,
  );

  assertIncludes(
    result.summary.failedTests?.[0]?.message,
    '...[truncated]',
    'Should bound an oversized failure message',
  );
  assertIncludes(
    result.firstErrorBlock,
    '...[truncated]',
    'Should apply the configured first error block limit',
  );
}

async function main(): Promise<void> {
  await runTestSuite({
    title: 'Testing Android JUnit XML report parser',
    tests: [
      { name: 'single failure report', run: testSingleFailureReport },
      { name: 'multiple reports and detail limit', run: testMultipleReportsAndDetailLimit },
      { name: 'malformed report fails safely', run: testMalformedReportFailsSafely },
      { name: 'failure detail bounds', run: testFailureDetailsAndFirstBlockAreBounded },
    ],
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
