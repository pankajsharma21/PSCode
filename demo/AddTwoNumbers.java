```java
public class AddTwoNumbers {
    public int add(int a, int b) {
        return a + b;
    }
}

public class Main {
    public static void main(String[] args) {
        AddTwoNumbers addTwoNumbers = new AddTwoNumbers();
        int result = addTwoNumbers.add(5, 3);
        System.out.println("5 + 3 = " + result);
    }
}
```