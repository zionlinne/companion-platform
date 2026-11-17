package app.deepcompanion.shell;

import java.nio.file.Files;
import java.nio.file.Path;

public final class OriginPolicyTest {
    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("expected cases file");
        int count = 0;
        for (String line : Files.readAllLines(Path.of(args[0]))) {
            if (line.isBlank() || line.startsWith("#")) continue;
            String[] parts = line.split("\t", -1);
            if (parts.length != 5) throw new AssertionError("bad case: " + line);
            OriginPolicy decision = OriginPolicy.parse(parts[1], Boolean.parseBoolean(parts[0]));
            boolean expectOk = Boolean.parseBoolean(parts[2]);
            if (decision.ok != expectOk || !decision.origin.equals(parts[3]) || !decision.reason.equals(parts[4])) {
                throw new AssertionError("case failed: " + line + " got ok=" + decision.ok + " origin=" + decision.origin + " reason=" + decision.reason);
            }
            count += 1;
        }
        if (count < 20) throw new AssertionError("too few cases");
        System.out.println("origin-policy java cases " + count);
    }
}
