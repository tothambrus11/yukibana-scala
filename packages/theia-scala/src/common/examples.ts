/**
 * The workspace a first-time visitor lands in.
 *
 * Chosen to look like the first weeks of an undergraduate Scala course rather than a
 * hello-world: an algebraic data type with exhaustive pattern matching, recursion in both its
 * naive and tail-recursive forms, and tests for both.
 *
 * The tests are hand-rolled because they have to be. Nothing here can reach Maven Central -
 * the classpath is the standard library and nothing else - so ScalaTest and munit are not
 * available. `MiniTest.scala` is the smallest thing that still teaches the shape: arrange,
 * assert, and a summary you can read.
 */
export const EXAMPLE_WORKSPACE: Record<string, string> = {
    'Main.scala': `// Press Run (or tick Autorun) to compile and execute this program in your browser.
// Everything here is compiled by a real Scala 3 compiler running on WebAssembly.

@main def run(): Unit =
  println("== Shapes ==")
  val shapes = List(Shape.Circle(1.0), Shape.Rectangle(2.0, 3.0), Shape.Triangle(4.0, 5.0))
  for shape <- shapes do
    println(s"  \${Shape.describe(shape)} -> area \${round2(Shape.area(shape))}")
  println(s"  total area: \${round2(Shape.totalArea(shapes))}")
  println(s"  largest:    \${Shape.largest(shapes).map(Shape.describe).getOrElse("none")}")

  println()
  println("== Recursion ==")
  println(s"  10!            = \${Recursion.factorial(10)}")
  println(s"  gcd(48, 18)    = \${Recursion.gcd(48, 18)}")
  println(s"  fib(0..9)      = \${(0 until 10).map(Recursion.fib).mkString(", ")}")
  println(s"  collatz(27)    = \${Recursion.collatzLength(27)} steps")

  println()
  println("== Tests ==")
  ShapeSpec.run()
  RecursionSpec.run()
  MiniTest.report()

/** Doubles print badly; two decimal places is enough to read an area by. */
def round2(value: Double): String =
  (math.round(value * 100).toDouble / 100).toString
`,

    'Shape.scala': `/** An algebraic data type: a Shape is exactly one of these three, and nothing else. */
enum Shape:
  case Circle(radius: Double)
  case Rectangle(width: Double, height: Double)
  case Triangle(base: Double, height: Double)

object Shape:
  /** Pattern matching over an ADT. Delete a case and the compiler warns that one is missing. */
  def area(shape: Shape): Double = shape match
    case Circle(radius)         => math.Pi * radius * radius
    case Rectangle(width, high) => width * high
    case Triangle(base, high)   => base * high / 2

  def describe(shape: Shape): String = shape match
    case Circle(radius)         => s"circle r=\$radius"
    case Rectangle(width, high) => s"rectangle \${width}x\$high"
    case Triangle(base, high)   => s"triangle b=\$base h=\$high"

  /** Collections are immutable by default; \`map\` and \`sum\` build a new value each time. */
  def totalArea(shapes: List[Shape]): Double = shapes.map(area).sum

  /** \`Option\` instead of null: an empty list simply has no largest shape. */
  def largest(shapes: List[Shape]): Option[Shape] = shapes.maxByOption(area)
`,

    'Recursion.scala': `import scala.annotation.tailrec

object Recursion:
  /** Straightforward recursion. Each call waits for the next, so the stack grows with n. */
  def factorial(n: Int): BigInt =
    if n <= 1 then BigInt(1) else n * factorial(n - 1)

  /** Tail recursive: the recursive call is the whole answer, so it compiles to a loop.
   *  \`@tailrec\` makes the compiler prove that - try adding \`+ 0\` to the call and see. */
  @tailrec
  def gcd(a: Int, b: Int): Int =
    if b == 0 then math.abs(a) else gcd(b, a % b)

  /** The usual exercise: turn a naive definition into a tail-recursive one with accumulators. */
  def fib(n: Int): BigInt =
    @tailrec def loop(remaining: Int, current: BigInt, next: BigInt): BigInt =
      if remaining == 0 then current else loop(remaining - 1, next, current + next)
    loop(n, BigInt(0), BigInt(1))

  /** How many steps the Collatz sequence takes to reach 1. Nobody knows if it always does. */
  def collatzLength(start: Int): Int =
    @tailrec def loop(n: Int, steps: Int): Int =
      if n == 1 then steps
      else if n % 2 == 0 then loop(n / 2, steps + 1)
      else loop(3 * n + 1, steps + 1)
    loop(start, 0)
`,

    'MiniTest.scala': `import scala.collection.mutable.ListBuffer

/** A test framework, in about thirty lines.
 *
 *  A course would normally hand you ScalaTest or munit. Nothing here can download a library,
 *  so this is what is left - and it is worth seeing once, because it is not much more than
 *  comparing two values and remembering what happened.
 */
object MiniTest:
  private var passed = 0
  private val failures = ListBuffer.empty[String]

  def assertEquals[A](label: String, actual: A, expected: A): Unit =
    if actual == expected then passed += 1
    else failures += s"\$label: expected \$expected, got \$actual"

  /** Floating point rarely compares equal; ask whether it is close enough instead. */
  def assertClose(label: String, actual: Double, expected: Double, tolerance: Double = 1e-9): Unit =
    if math.abs(actual - expected) <= tolerance then passed += 1
    else failures += s"\$label: expected \$expected, got \$actual"

  def assertTrue(label: String, condition: Boolean): Unit =
    assertEquals(label, condition, true)

  /** Print what happened. Returns false if anything failed, so a caller can react. */
  def report(): Boolean =
    if failures.isEmpty then
      println(s"  All \$passed checks passed.")
      true
    else
      println(s"  \${failures.size} of \${passed + failures.size} checks FAILED:")
      for failure <- failures do println(s"    - \$failure")
      false
`,

    'ShapeSpec.scala': `import MiniTest.*

/** Tests for Shape. Each one names what it checks, so a failure reads like a sentence. */
object ShapeSpec:
  private val shapes = List(Shape.Circle(1.0), Shape.Rectangle(2.0, 3.0), Shape.Triangle(4.0, 5.0))

  def run(): Unit =
    assertClose("area of a circle", Shape.area(Shape.Circle(2.0)), 4 * math.Pi)
    assertClose("area of a rectangle", Shape.area(Shape.Rectangle(3.0, 4.0)), 12.0)
    assertClose("area of a triangle", Shape.area(Shape.Triangle(6.0, 2.0)), 6.0)
    assertClose("total area of several shapes", Shape.totalArea(shapes), math.Pi + 6.0 + 10.0)
    assertEquals("largest of several shapes", Shape.largest(shapes), Some(Shape.Triangle(4.0, 5.0)))
    assertEquals("an empty list has no largest shape", Shape.largest(Nil), None)
`,

    'RecursionSpec.scala': `import MiniTest.*

object RecursionSpec:
  def run(): Unit =
    assertEquals("0! is 1", Recursion.factorial(0), BigInt(1))
    assertEquals("10! is 3628800", Recursion.factorial(10), BigInt(3628800))
    assertEquals("gcd(48, 18) is 6", Recursion.gcd(48, 18), 6)
    assertEquals("gcd is symmetric", Recursion.gcd(18, 48), Recursion.gcd(48, 18))
    assertEquals("fib(10) is 55", Recursion.fib(10), BigInt(55))
    assertEquals("collatz(6) takes 8 steps", Recursion.collatzLength(6), 8)
`,
};

/** The file a visitor should be looking at when the workspace opens. */
export const EXAMPLE_ENTRY_FILE = 'Main.scala';

/**
 * `Main.scala` as earlier versions seeded it.
 *
 * Someone who visited before the examples existed has a workspace containing exactly this and
 * nothing else, and would otherwise keep it forever - the seeding only ever ran when
 * `Main.scala` was missing. Replacing a file byte-identical to what we wrote ourselves is
 * safe; anything they have touched is left alone.
 */
const SUPERSEDED_SAMPLES: readonly string[] = [
    `@main def hello(): Unit =
  val squares = (1 to 5).map(n => n * n)
  println(s"squares: \${squares.mkString(", ")}")
  println(s"sum = \${squares.sum}")
`,
];

/**
 * May this file be replaced with the current example?
 *
 * Only the entry file, and only when its contents are byte-identical to something an earlier
 * version of this extension wrote. Anything a person has touched - even by one character - is
 * theirs, and upgrading is never worth losing someone's work.
 */
export function isSupersededSample(name: string, content: string): boolean {
    return name === EXAMPLE_ENTRY_FILE && SUPERSEDED_SAMPLES.includes(content);
}
