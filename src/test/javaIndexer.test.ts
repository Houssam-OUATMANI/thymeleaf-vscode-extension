import { strict as assert } from "node:assert";
import { test } from "node:test";
import { indexJavaSources } from "../server/javaIndexer";

test("indexes Spring routes, view names, model attributes, and Java properties", () => {
  const sources = new Map([
    [
      "C:/project/src/main/java/demo/UserController.java",
      `package demo;
       import org.springframework.stereotype.Controller;
       import org.springframework.web.bind.annotation.GetMapping;
       import org.springframework.web.bind.annotation.ModelAttribute;
       import org.springframework.web.bind.annotation.RequestMapping;
       @Controller
       @RequestMapping("/users")
       class UserController {
         @GetMapping("/list")
         String list(@ModelAttribute("user") UserForm form) {
           return "users/list";
         }
       }`
    ],
    [
      "C:/project/src/main/java/demo/UserForm.java",
      `package demo;
       class UserForm {
         private String displayName;
         public String getDisplayName() { return displayName; }
       }`
    ]
  ]);

  const index = indexJavaSources(sources);
  const handler = index.handlers.find(({ name }) => name === "list");
  const userForm = index.classes.find(({ name }) => name === "UserForm");

  assert.ok(handler);
  assert.deepEqual(handler.routePaths, ["/users/list"]);
  assert.equal(handler.viewName, "users/list");
  assert.equal(handler.modelAttributes.get("user"), "UserForm");
  assert.ok(userForm?.properties.has("displayName"));
  assert.equal(userForm?.properties.get("displayName")?.typeName, "String");
});

test("ignores Java comments when finding mappings and model properties", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/PageController.java", `
      // @Controller @GetMapping("/fake")
      class PageController {
        /* @GetMapping("/also-fake") */
        String page() { return "home"; }
      }
    `]
  ]));

  assert.equal(index.handlers.length, 0);
});

test("indexes Java record components as properties and accessors", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/UserRecord.java", `
      package demo;
      public record UserRecord(Long id, String email, String fullName) {}
    `]
  ]));

  const recordClass = index.classes.find(({ name }) => name === "UserRecord");
  assert.ok(recordClass);
  assert.equal(recordClass?.properties.get("id")?.typeName, "Long");
  assert.equal(recordClass?.properties.get("email")?.typeName, "String");
  assert.equal(recordClass?.properties.get("fullName")?.typeName, "String");
  assert.equal(recordClass?.methodReturnTypes.get("email"), "String");
  assert.equal(recordClass?.methodReturnTypes.get("fullName"), "String");
});

test("indexes generic Java type parameters and references", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/Box.java", `
      package demo;
      class Box<T extends Serializable, K> {
        Map<K, T> values;
      }
    `]
  ]));
  const box = index.classes.find(({ name }) => name === "Box");

  assert.deepEqual(box?.typeParameters, ["T", "K"]);
  assert.equal(box?.superClassName, undefined);
  assert.deepEqual(
    index.typeReferences.map(({ typeName }) => typeName).sort(),
    ["K", "Map", "Serializable", "T"]
  );
});

test("indexes Lombok classes with complex annotated fields", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/ProductDto.java", `
      package demo;
      import lombok.Data;
      import jakarta.validation.constraints.Size;
      @Data
      public class ProductDto {
        @Size(min = 2, max = 100)
        private String title = "default";
        private Double price;
        private boolean active;
      }
    `]
  ]));

  const productClass = index.classes.find(({ name }) => name === "ProductDto");
  assert.ok(productClass);
  assert.equal(productClass?.properties.get("title")?.typeName, "String");
  assert.equal(productClass?.properties.get("price")?.typeName, "Double");
  assert.equal(productClass?.properties.get("active")?.typeName, "boolean");
  assert.equal(productClass?.methodReturnTypes.get("getTitle"), "String");
  assert.equal(productClass?.methodReturnTypes.get("getPrice"), "Double");
  assert.equal(productClass?.methodReturnTypes.get("isActive"), "boolean");
});

test("indexes superClassName for Java class inheritance", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/BaseEntity.java", `
      package demo;
      public class BaseEntity {
        private Long id;
        public Long getId() { return id; }
      }
    `],
    ["C:/project/src/main/java/demo/Customer.java", `
      package demo;
      public class Customer extends BaseEntity {
        private String name;
        public String getName() { return name; }
      }
    `]
  ]));

  const customerClass = index.classes.find(({ name }) => name === "Customer");
  assert.ok(customerClass);
  assert.equal(customerClass?.superClassName, "BaseEntity");
  assert.ok(customerClass?.properties.has("name"));
});

test("infers var model attributes from generic service method return types", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/PostController.java", `
      package demo;
      @Controller
      class PostController {
        private PostService postService;
        String index(Model model) {
          var ps = postService.index();
          model.addAttribute("ps", ps);
          return "index";
        }
      }
    `],
    ["C:/project/src/main/java/demo/PostService.java", `
      package demo;
      class PostService {
        private PostRepository postRepository;
        Page<PostResponseDto> index() { return postRepository.index(); }
      }
    `],
    ["C:/project/src/main/java/demo/PostRepository.java", `
      package demo;
      interface PostRepository {
        Page<PostResponseDto> index();
      }
    `],
    ["C:/project/src/main/java/demo/PostResponseDto.java", `
      package demo;
      class PostResponseDto {
        private Long id;
      }
    `]
  ]));

  const handler = index.handlers.find(({ name }) => name === "index");
  assert.equal(handler?.modelAttributes.get("ps"), "Page<PostResponseDto>");
});

test("infers direct and chained service or repository calls through generic supertypes", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/PlayerController.java", `
      package demo;
      @Controller
      class PlayerController {
        private PlayerRepository playerRepository;
        private PlayerService playerService;
        String index(Model model) {
          model.addAttribute("players", playerRepository.findAll());
          model.addAttribute("servicePlayers", playerService.getRepository().findAll());
          return "players";
        }
      }
    `],
    ["C:/project/src/main/java/demo/PlayerService.java", `
      package demo;
      class PlayerService {
        private PlayerRepository playerRepository;
        PlayerRepository getRepository() { return playerRepository; }
      }
    `],
    ["C:/project/src/main/java/demo/PlayerRepository.java", `
      package demo;
      interface PlayerRepository extends BaseRepository<Player> {}
    `],
    ["C:/project/src/main/java/demo/BaseRepository.java", `
      package demo;
      interface BaseRepository<T> {
        java.util.List<T> findAll();
      }
    `],
    ["C:/project/src/main/java/demo/Player.java", `
      package demo;
      class Player { private String name; }
    `]
  ]));

  const handler = index.handlers.find(({ name }) => name === "index");
  assert.equal(handler?.modelAttributes.get("players"), "List<Player>");
  assert.equal(handler?.modelAttributes.get("servicePlayers"), "List<Player>");
});

test("does not expose Spring infrastructure or scalar handler parameters as model attributes", () => {
  const index = indexJavaSources(new Map([
    ["C:/project/src/main/java/demo/UserController.java", `
      package demo;
      @Controller
      class UserController {
        @GetMapping
        String index(Model model, UUID filter, RedirectAttributes redirectAttributes, UserForm user) {
          model.addAttribute("activeUser", user);
          return "index";
        }
      }
    `],
    ["C:/project/src/main/java/demo/UserForm.java", `
      package demo;
      class UserForm { private String name; }
    `]
  ]));

  const handler = index.handlers.find(({ name }) => name === "index");
  assert.equal(handler?.modelAttributes.has("model"), false);
  assert.equal(handler?.modelAttributes.has("filter"), false);
  assert.equal(handler?.modelAttributes.has("redirectAttributes"), false);
  assert.equal(handler?.modelAttributes.get("user"), "UserForm");
  assert.equal(handler?.modelAttributes.get("activeUser"), "UserForm");
});

test("indexes Java type reference positions for compiler-backed resolution", () => {
  const source = `package demo;
class UserForm {}
class UserController {
  Page<PostDto> list(UserForm user, Model model) {
    model.addAttribute("post", new PostDto());
    PostDto typed = null;
    return null;
  }
}`;
  const index = indexJavaSources(new Map([["C:/project/src/main/java/demo/UserController.java", source]]));
  const references = index.typeReferences;

  assert.ok(references.some(({ typeName, position }) =>
    typeName === "Page" && position.line === 3 && position.character === 2
  ));
  assert.ok(references.some(({ typeName, position }) =>
    typeName === "PostDto" && position.line === 3 && position.character === 7
  ));
  assert.ok(references.some(({ typeName }) => typeName === "UserForm"));
  assert.ok(references.some(({ typeName, position }) =>
    typeName === "PostDto" && position.line === 4 && position.character > 20
  ));
  assert.ok(references.some(({ typeName, position }) =>
    typeName === "PostDto" && position.line === 5 && position.character === 4
  ));
});
